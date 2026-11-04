using System.Data;
using Microsoft.EntityFrameworkCore;
using Spatia.ProjectFormat;
using Spatia.Server.Persistence;
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
            var approval = await ReviewApproval.CheckLockedAsync(database, project, cancellationToken);
            if (approval == ReviewApprovalState.ApprovalRequired)
            {
                return PublicationResult.Rejected(PublicationRejection.ApprovalRequired);
            }
            if (approval == ReviewApprovalState.StaleProject)
            {
                return PublicationResult.Rejected(PublicationRejection.DependencyUnavailable);
            }
            var parsed = documents.ReadStored(projectId, project.SchemaVersion, project.UnvalidatedDocumentJson);
            if (!parsed.Ok) { return PublicationResult.Rejected(PublicationRejection.InvalidDocument); }
            var requiredAssets = PublicationDocumentAssets.Required(parsed.Value!);
            var prepared = await _integration.PrepareAsync(database, project, request, parsed.Value!, cancellationToken);
            if (prepared.Failure is { } preparationFailure) { return PublicationResult.Rejected(preparationFailure); }
            if (approval == ReviewApprovalState.UnverifiedOrigin && !prepared.OrdinaryOriginVerified)
            {
                return PublicationResult.Rejected(PublicationRejection.DependencyUnavailable);
            }
            if (ProjectCapabilities.Missing(parsed.Value!, prepared.SupportedCapabilities).Count != 0)
            {
                return PublicationResult.Rejected(PublicationRejection.UnsupportedRuntime);
            }
            string manifest;
            try
            {
                manifest = PublicationAssetManifest.Serialize(prepared.References);
            }
            catch (ArgumentException)
            {
                return PublicationResult.Rejected(PublicationRejection.InvalidAssets);
            }
            if (!requiredAssets.IsSubsetOf(prepared.References.Select(reference => reference.AssetId)))
            {
                return PublicationResult.Rejected(PublicationRejection.InvalidAssets);
            }
            if (HasExpired(context)) { return PublicationResult.Denied(ProjectAccessFailure.AuthenticationRequired); }

            // Target only the global ID constraint. Other database errors propagate and roll back;
            // ON CONFLICT avoids poisoning the transaction when another project's lock is involved.
            var inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO publications (id, project_id, published_by_id, source_revision, schema_version,
                    document, asset_references, request_digest)
                VALUES ({request.PublicationId}, {projectId}, {project.ActorId}, {project.Revision}, {project.SchemaVersion},
                    CAST({project.UnvalidatedDocumentJson} AS jsonb), CAST({manifest} AS jsonb), {digest})
                ON CONFLICT (id) DO NOTHING
                """, cancellationToken);
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
        if (HasExpired(context)) { return PublicationResult.Denied(ProjectAccessFailure.AuthenticationRequired); }
        await transaction.CommitAsync(cancellationToken);
        // A canceled/failed commit can already be durable. Only the next same-ID request reconciles it.
        cancellationToken.ThrowIfCancellationRequested();
        return HasExpired(context)
            ? PublicationResult.Denied(ProjectAccessFailure.AuthenticationRequired)
            : PublicationResult.Committed(edition!, replay);
    }

    private Task<Publication?> FindAsync(Guid id, CancellationToken cancellationToken) =>
        database.Publications.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id, cancellationToken);

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
}
