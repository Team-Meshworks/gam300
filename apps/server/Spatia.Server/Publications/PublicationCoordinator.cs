using System.Data;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.ProjectFormat;
using Spatia.Server.Persistence;
using Spatia.Server.Accounts;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

/// <summary>Owns the shared lock, exact-revision capture, durable retry and atomic publication commit</summary>
/// <remarks>
/// The protected API supplies its scoped access/asset integration. Direct callers without that
/// integration remain unavailable, including in Development.
/// </remarks>
internal sealed class PublicationCoordinator(ApplicationDbContext database, ProjectAccessService access,
    ProjectDocumentService documents, IPublicationIntegration? integration = null)
{
    private readonly IPublicationIntegration _integration = integration ?? new UnavailablePublicationIntegration();

    // Report prerequisites through the same authority and preparation checks used at commit
    // This read never stages a publication or promises that a later write will still be authorised
    internal async Task<PublicationReadinessResult> ReadinessAsync(HttpContext context, Guid projectId,
        CancellationToken token)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, token);
        var authorization = await access.LockAsync(context, projectId, ProjectLockPurpose.Publish, token);
        if (authorization.Failure is { } failure) { return new(0, null, null, null, failure); }
        var project = authorization.Snapshot!;
        var request = new PublicationRequest(Guid.NewGuid(), project.Revision, """{"audience":"Authenticated","viewerIds":[]}""");
        var prepared = await PrepareNewAsync(context, project, request, token);
        var approval = await ReviewApproval.CheckLockedAsync(database, project, token);
        bool? completed = approval == ReviewApprovalState.UnverifiedOrigin ? null
            : await database.ReviewSubmissions.AnyAsync(row => row.ProjectId == projectId && row.SourceRevision == project.Revision, token);
        bool? approved = approval == ReviewApprovalState.UnverifiedOrigin ? null : approval == ReviewApprovalState.Approved;
        var current = await access.LockAsync(context, projectId, ProjectLockPurpose.Publish, token);
        if (current.Failure is { } changed) { return new(0, null, null, null, changed); }
        if (HasExpired(context)) { return new(0, null, null, null, ProjectAccessFailure.AuthenticationRequired); }
        // Return only stable feature names and paths after the final access check
        return new(project.Revision, prepared.Failure, completed, approved, MissingCapabilities: prepared.MissingCapabilities);
    }

    public async Task<PublicationResult> PublishAsync(HttpContext context, Guid projectId, PublicationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(request);
        if (projectId == Guid.Empty) { throw new ArgumentException("A project ID is required.", nameof(projectId)); }
        cancellationToken.ThrowIfCancellationRequested();
        if (database.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException("Publications require ownership of their transaction.");
        }

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, projectId, ProjectLockPurpose.Publish, cancellationToken);
        if (authorization.Failure is { } failure) { return PublicationResult.Denied(failure); }
        var project = authorization.Snapshot!;
        if (await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids WHERE id = {request.PublicationId}")
            .AnyAsync(cancellationToken))
        {
            return PublicationResult.Rejected(PublicationRejection.IdConflict);
        }
        var digest = request.Digest(projectId, project.ActorId);
        var edition = await FindAsync(request.PublicationId, cancellationToken);
        var decision = PublicationRetryPolicy.Decide(edition, request.PublicationId, projectId, project.ActorId,
            request.ConfirmedRevision, digest);
        if (decision == PublicationRetryDecision.Conflict) { return PublicationResult.Rejected(PublicationRejection.IdConflict); }

        var replay = decision == PublicationRetryDecision.Replay;
        if (!replay)
        {
            if (project.Revision != request.ConfirmedRevision)
            {
                return PublicationResult.Rejected(PublicationRejection.RevisionConflict, project.Revision);
            }
            var prepared = await PrepareNewAsync(context, project, request, cancellationToken);
            if (prepared.Failure is { } preparationFailure) { return PublicationResult.Rejected(preparationFailure); }
            var manifest = prepared.Manifest!;
            if (HasExpired(context)) { return PublicationResult.Denied(ProjectAccessFailure.AuthenticationRequired); }

            // Target only the global ID constraint. Other database errors propagate and roll back;
            // ON CONFLICT avoids poisoning the transaction when another project's lock is involved.
            int inserted;
            try
            {
                inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO publications (id, project_id, published_by_id, source_revision, schema_version,
                    document, asset_references, request_digest)
                VALUES ({request.PublicationId}, {projectId}, {project.ActorId}, {project.Revision}, {project.SchemaVersion},
                    CAST({project.UnvalidatedDocumentJson} AS jsonb), CAST({manifest} AS jsonb), {digest})
                ON CONFLICT (id) DO NOTHING
                """, cancellationToken);
            }
            catch (PostgresException exception) when (exception.ConstraintName == "CK_publication_id_retired")
            {
                return PublicationResult.Rejected(PublicationRejection.IdConflict);
            }
            edition = await FindAsync(request.PublicationId, cancellationToken)
                ?? throw new InvalidOperationException("The publication insert produced no durable identity.");
            if (PublicationRetryPolicy.Decide(edition, request.PublicationId, projectId, project.ActorId,
                request.ConfirmedRevision, digest) != PublicationRetryDecision.Replay)
            {
                return PublicationResult.Rejected(PublicationRejection.IdConflict);
            }
            replay = inserted == 0;
            if (!replay && await _integration.StageAsync(database, project, request, edition, cancellationToken) is { } stageFailure)
            {
                return PublicationResult.Rejected(stageFailure);
            }
        }

        if (replay && await _integration.AuthorizeReplayAsync(database, project, request, edition!, cancellationToken) is { } replayFailure)
        {
            return PublicationResult.Rejected(replayFailure);
        }

        // Asset resolution, policy staging or a competing ID can take time. Reuse the same authority
        // service to check account/stamp/role/organization/session again before committing or replaying.
        var current = await access.LockAsync(context, projectId, ProjectLockPurpose.Publish, cancellationToken);
        if (current.Failure is { } currentFailure) { return PublicationResult.Denied(currentFailure); }
        if (!replay && current.Snapshot!.Revision != request.ConfirmedRevision)
        {
            return PublicationResult.Rejected(PublicationRejection.RevisionConflict, current.Snapshot.Revision);
        }
        var currentAccount = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (currentAccount?.Role == ApplicationRoles.Educator
            && await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == projectId, cancellationToken)
            && !await database.ProjectAssignments.AnyAsync(row => row.ProjectId == projectId
                && row.UserId == current.Snapshot!.ActorId && row.CanManage && row.CanPublish, cancellationToken))
        { return PublicationResult.Rejected(PublicationRejection.PolicyDenied); }
        using (var intent = JsonDocument.Parse(request.IntentJson))
        {
            var overrides = intent.RootElement.EnumerateObject().Where(property => property.Name == "teacherOverride").ToArray();
            if (overrides.Length != 0)
            {
                var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
                if (overrides.Length != 1 || overrides[0].Value.ValueKind != JsonValueKind.True
                    || account is null || account.Role != ApplicationRoles.Educator
                    || !current.Snapshot!.CanManage || !current.Snapshot.CanPublish
                    || !await database.ProjectAssignments.AnyAsync(row => row.ProjectId == projectId
                        && row.UserId == current.Snapshot.ActorId && row.CanManage && row.CanPublish, cancellationToken)
                    || !await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == projectId && row.IsActive, cancellationToken))
                { return PublicationResult.Rejected(PublicationRejection.PolicyDenied); }
            }
        }
        if (HasExpired(context)) { return PublicationResult.Denied(ProjectAccessFailure.AuthenticationRequired); }
        await transaction.CommitAsync(cancellationToken);
        // A canceled/failed commit can already be durable. Only the next same-ID request reconciles it.
        cancellationToken.ThrowIfCancellationRequested();
        return HasExpired(context)
            ? PublicationResult.Denied(ProjectAccessFailure.AuthenticationRequired)
            : PublicationResult.Committed(edition!, replay);
    }

    private async Task<(PublicationRejection? Failure, string? Manifest, IReadOnlyList<CapabilityIssue> MissingCapabilities)> PrepareNewAsync(
        HttpContext context, ProjectAccessSnapshot project, PublicationRequest request, CancellationToken token)
    {
        var approval = await ReviewApproval.CheckLockedAsync(database, project, token);
        using var intent = JsonDocument.Parse(request.IntentJson);
        var overrides = intent.RootElement.EnumerateObject().Where(property => property.Name == "teacherOverride").ToArray();
        if (approval == ReviewApprovalState.ApprovalRequired)
        { return (PublicationRejection.ApprovalRequired, null, []); }
        if (overrides.Length != 0)
        {
            var account = await access.ResolveCurrentAccountAsync(context, token);
            if (overrides.Length != 1 || overrides[0].Value.ValueKind != JsonValueKind.True
                || approval is ReviewApprovalState.UnverifiedOrigin or ReviewApprovalState.StaleProject
                || account is null || account.Role != ApplicationRoles.Educator || !project.CanManage || !project.CanPublish)
            { return (PublicationRejection.PolicyDenied, null, []); }
        }
        if (approval == ReviewApprovalState.StaleProject) { return (PublicationRejection.DependencyUnavailable, null, []); }
        var parsed = documents.ReadStored(project.ProjectId, project.SchemaVersion, project.UnvalidatedDocumentJson);
        if (!parsed.Ok) { return (PublicationRejection.InvalidDocument, null, []); }
        var requiredAssets = PublicationDocumentAssets.Required(parsed.Value!);
        var prepared = await _integration.PrepareAsync(database, project, request, parsed.Value!, token);
        if (prepared.Failure is { } failure) { return (failure, null, prepared.MissingCapabilities); }
        if (approval == ReviewApprovalState.UnverifiedOrigin && !prepared.OrdinaryOriginVerified)
        { return (PublicationRejection.DependencyUnavailable, null, []); }
        var missing = ProjectCapabilities.Missing(parsed.Value!, prepared.SupportedCapabilities);
        if (missing.Count != 0)
        { return (PublicationRejection.UnsupportedRuntime, null, missing); }
        string manifest;
        try { manifest = PublicationAssetManifest.Serialize(prepared.References); }
        catch (ArgumentException) { return (PublicationRejection.InvalidAssets, null, []); }
        return requiredAssets.IsSubsetOf(prepared.References.Select(reference => reference.AssetId))
            ? (null, manifest, []) : (PublicationRejection.InvalidAssets, null, []);
    }

    private Task<Publication?> FindAsync(Guid id, CancellationToken cancellationToken) =>
        database.Publications.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id, cancellationToken);

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
}
