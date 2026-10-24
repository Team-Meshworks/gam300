using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Persistence;

namespace Spatia.Server.Projects;

/// <summary>
/// Stages conditional project draft updates inside a transaction owned by the caller
/// </summary>
/// <param name="database">The scoped context holding the caller's read-committed transaction and project lock</param>
public sealed class ProjectSaveWriter(ApplicationDbContext database)
{
    /// <summary>
    /// Stages one conditional draft update without committing or acknowledging it
    /// </summary>
    /// <param name="project">The editable snapshot obtained while holding an EditDraft lock</param>
    /// <param name="expectedRevision">The revision the client intends to replace</param>
    /// <param name="clientMutationId">The stable identifier reused when retrying this mutation</param>
    /// <param name="schemaVersion">The validated schema version matching the document</param>
    /// <param name="documentJson">The document JSON already accepted by domain validation</param>
    /// <param name="requestDigest">
    /// The 32-byte server-derived digest bound to the document, project, actor and revision
    /// </param>
    /// <param name="cancellationToken">The token used to cancel the conditional database update</param>
    /// <returns>True when one update is staged, or false when the policy or current row prevents a new write</returns>
    /// <remarks>
    /// The caller must validate input, obtain an EditDraft lock and retain its transaction through commit or rollback
    /// </remarks>
    /// <exception cref="ArgumentNullException">The project, document JSON or request digest is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">The expected revision is outside the supported range</exception>
    /// <exception cref="ArgumentException">The digest or editable snapshot metadata is invalid</exception>
    /// <exception cref="InvalidOperationException">A caller-owned read-committed transaction is not active</exception>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    // TODO: Require SCRUM-50 validation and server-side digest generation in the save service's production entry point
    public async Task<bool> TryStageAsync(ProjectAccessSnapshot project, long expectedRevision,
        Guid clientMutationId, int schemaVersion, string documentJson, byte[] requestDigest,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(documentJson);
        ArgumentNullException.ThrowIfNull(requestDigest);
        cancellationToken.ThrowIfCancellationRequested();

        var transaction = database.Database.CurrentTransaction;
        if (transaction is null || transaction.GetDbTransaction().IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw new InvalidOperationException("Draft staging requires a caller-owned read-committed transaction.");
        }
        if (ProjectSavePolicy.Decide(project, expectedRevision, clientMutationId, requestDigest)
            != ProjectSaveDecision.WriteRequired)
        {
            return false;
        }

        // TODO: Supply document/schema accepted by SCRUM-50; relational checks cannot validate authored content
        // TODO: Supply a server digest of the agreed SCRUM-50 representation and original project/actor/revision
        var affected = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE projects
            SET document = CAST({documentJson} AS jsonb),
                schema_version = {schemaVersion},
                revision = revision + 1,
                updated_at = statement_timestamp(),
                last_mutation_actor_id = {project.ActorId},
                last_mutation_id = {clientMutationId},
                last_mutation_digest = {requestDigest}
            WHERE id = {project.ProjectId}
                AND organization_id = {project.OrganizationId}
                AND revision = {project.Revision}
                AND archived = FALSE
            """, cancellationToken);

        return affected == 1;
    }
}
