using System.Data;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>
/// Coordinates authorized draft writes and retries, acknowledging only completed transaction commits
/// </summary>
/// <param name="database">The scoped database context that owns each save transaction</param>
/// <param name="access">The project authorization service sharing the same database context</param>
public sealed class ProjectSaveService(ApplicationDbContext database, ProjectAccessService access)
{
    /// <summary>
    /// Owns authorized save and retry transactions for caller-validated content and a server-derived digest
    /// </summary>
    /// <param name="context">The authenticated request carrying a validated account session</param>
    /// <param name="projectId">The project identifier already checked against the document</param>
    /// <param name="envelope">The parsed request whose original document must have passed domain validation</param>
    /// <param name="schemaVersion">The validated schema version matching the supplied document</param>
    /// <param name="requestDigest">
    /// The 32-byte server-derived digest bound to the document, project, actor and revision
    /// </param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>
    /// A committed acknowledgement, an access denial, or a revision rejection with the current revision
    /// </returns>
    /// <remarks>
    /// A failed or canceled commit can already be durable; reconcile uncertain outcomes using the same mutation ID
    /// </remarks>
    /// <exception cref="ArgumentNullException">The context, envelope or request digest is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The envelope's expected revision is outside the supported range
    /// </exception>
    /// <exception cref="ArgumentException">
    /// The digest is not 32 bytes or the locked snapshot has invalid metadata
    /// </exception>
    /// <exception cref="InvalidOperationException">The context already has a transaction</exception>
    /// <exception cref="OperationCanceledException">
    /// The operation is canceled, possibly after its commit became durable
    /// </exception>
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
