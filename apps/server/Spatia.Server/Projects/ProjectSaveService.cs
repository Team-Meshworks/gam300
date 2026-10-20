using System.Data;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

public sealed class ProjectSaveService(ApplicationDbContext database, ProjectAccessService access)
{
    /// <summary>Owns current-authorized save/retry transactions for caller-validated content and a server-derived digest</summary>
    // TODO: Integrate SCRUM-50 validation and digest generation before registering or exposing this service to requests
    public async Task<ProjectSaveResult> SaveAsync(HttpContext context, Guid projectId, ParsedSaveEnvelope envelope,
        int schemaVersion, byte[] requestDigest, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(requestDigest);
        cancellationToken.ThrowIfCancellationRequested();
        if (requestDigest.Length != 32)
        {
            throw new ArgumentException("A request digest must contain exactly 32 bytes.", nameof(requestDigest));
        }
        if (database.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException("Project saves require ownership of their transaction.");
        }

        // TODO: Derive this digest server-side from the SCRUM-50 representation and original project/actor/revision
        var digest = requestDigest.ToArray();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, projectId, ProjectLockPurpose.EditDraft, cancellationToken);
        if (authorization.Failure is { } failure)
        {
            return ProjectSaveResult.Denied(failure);
        }
        if (HasExpired(context))
        {
            return ProjectSaveResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }

        var project = authorization.Snapshot!;
        var decision = ProjectSavePolicy.Decide(project, envelope.ExpectedRevision, envelope.ClientMutationId, digest);
        if (decision is ProjectSaveDecision.Conflict or ProjectSaveDecision.RevisionExhausted)
        {
            return ProjectSaveResult.Rejected(decision, project.Revision);
        }

        ProjectSaveAcknowledgement acknowledgement;
        if (decision == ProjectSaveDecision.Replay)
        {
            acknowledgement = new(projectId, project.Revision, envelope.ClientMutationId, project.UpdatedAt);
        }
        else
        {
            // TODO: Require SCRUM-50 acceptance of this original document, route binding and schema version before staging
            var staged = await new ProjectSaveWriter(database).TryStageAsync(project, envelope.ExpectedRevision,
                envelope.ClientMutationId, schemaVersion, envelope.UnvalidatedDocumentJson, digest, cancellationToken);
            if (HasExpired(context))
            {
                return ProjectSaveResult.Denied(ProjectAccessFailure.AuthenticationRequired);
            }
            if (!staged)
            {
                return ProjectSaveResult.Rejected(ProjectSaveDecision.Conflict, project.Revision);
            }

            acknowledgement = await database.Projects.AsNoTracking().Where(row => row.Id == projectId)
                .Select(row => new ProjectSaveAcknowledgement(row.Id, row.Revision, envelope.ClientMutationId, row.UpdatedAt))
                .SingleAsync(cancellationToken);
        }

        if (HasExpired(context))
        {
            return ProjectSaveResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }
        // A failed or canceled commit may already be durable; reconciliation must reuse the same mutation ID
        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return HasExpired(context)
            ? ProjectSaveResult.Denied(ProjectAccessFailure.AuthenticationRequired)
            : ProjectSaveResult.Committed(acknowledgement);
    }

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
}
