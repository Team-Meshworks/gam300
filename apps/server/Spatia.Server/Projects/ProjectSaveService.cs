using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>
/// Coordinates authorized draft writes and retries, acknowledging only completed transaction commits
/// </summary>
/// <param name="database">The scoped database context that owns each save transaction</param>
/// <param name="access">The project authorization service sharing the same database context</param>
/// <param name="documents">The trusted document validator and serializer</param>
public sealed class ProjectSaveService(ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents)
{
    /// <summary>
    /// Validates original input and owns authorized save and retry transactions with a server-derived digest
    /// </summary>
    /// <param name="context">The authenticated request carrying a validated account session</param>
    /// <param name="projectId">The project identifier to authorize and bind to the document</param>
    /// <param name="envelope">The bounded parsed request with its original unvalidated document</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>
    /// A committed acknowledgement, an access or document denial, or an authorized revision rejection
    /// </returns>
    /// <remarks>
    /// A failed or canceled commit can already be durable; reconcile uncertain outcomes using the same mutation ID
    /// </remarks>
    /// <exception cref="ArgumentNullException">The context or envelope is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The envelope's expected revision is outside the supported range
    /// </exception>
    /// <exception cref="ArgumentException">
    /// The locked snapshot has invalid metadata
    /// </exception>
    /// <exception cref="InvalidOperationException">The context already has a transaction</exception>
    /// <exception cref="OperationCanceledException">
    /// The operation is canceled, possibly after its commit became durable
    /// </exception>
    public async Task<ProjectSaveResult> SaveAsync(HttpContext context, Guid projectId, ParsedSaveEnvelope envelope,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(envelope);
        cancellationToken.ThrowIfCancellationRequested();
        if (envelope.ExpectedRevision < 0 || envelope.ExpectedRevision > Project.MaxRevision)
        {
            throw new ArgumentOutOfRangeException(nameof(envelope));
        }
        if (database.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException("Project saves require ownership of their transaction.");
        }

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
        // Fixed UUID fields and a newline-terminated decimal revision frame the final original UTF-8 document
        // Retry identity deliberately retains whitespace, key order and number spelling; storage does not
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(
            $"spatia-save-v1\n{projectId:D}\n{project.ActorId:D}\n{envelope.ExpectedRevision.ToString(CultureInfo.InvariantCulture)}\n"
            + envelope.UnvalidatedDocumentJson));
        var receipt = await database.ProjectSaveReceipts.AsNoTracking().SingleOrDefaultAsync(
            row => row.ProjectId == projectId && row.ClientMutationId == envelope.ClientMutationId, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (HasExpired(context))
        {
            return ProjectSaveResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }
        var decision = ProjectSavePolicy.Decide(project, envelope.ExpectedRevision, envelope.ClientMutationId, digest, receipt);

        ProjectSaveAcknowledgement acknowledgement;
        if (receipt is not null)
        {
            if (decision != ProjectSaveDecision.Replay)
            {
                return ProjectSaveResult.Rejected(decision, project.Revision);
            }
            // Reconciliation confirms a previous commit even if its content no longer passes today's catalogue
            acknowledgement = new(projectId, receipt.Revision, receipt.ClientMutationId, receipt.SavedAt);
        }
        else
        {
            // Preserve previously saved retired assets when validating a fresh mutation
            var document = documents.Read(projectId, envelope.UnvalidatedDocumentJson, project.UnvalidatedDocumentJson);
            if (!document.Ok) { return ProjectSaveResult.Invalid(); }
            var serialized = documents.Serialize(document.Value!);
            if (!serialized.Ok) { return ProjectSaveResult.Invalid(); }
            cancellationToken.ThrowIfCancellationRequested();
            if (HasExpired(context))
            {
                return ProjectSaveResult.Denied(ProjectAccessFailure.AuthenticationRequired);
            }
            if (decision is ProjectSaveDecision.Conflict or ProjectSaveDecision.RevisionExhausted)
            {
                return ProjectSaveResult.Rejected(decision, project.Revision);
            }
            var staged = await new ProjectSaveWriter(database).TryStageAsync(project, envelope.ExpectedRevision,
                envelope.ClientMutationId, document.Value!.SchemaVersion, serialized.Value!, digest, cancellationToken);
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
