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
    /// Stages one conditional draft update and its receipt without committing or acknowledging it
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
        if (ProjectSavePolicy.Decide(project, expectedRevision, clientMutationId, requestDigest, receipt: null)
            != ProjectSaveDecision.WriteRequired)
        {
            return false;
        }

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
                AND NOT EXISTS (SELECT 1 FROM project_save_receipts
                    WHERE project_id = {project.ProjectId} AND client_mutation_id = {clientMutationId})
            """, cancellationToken);

        if (affected != 1) { return false; }
        var inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO project_save_receipts
                (project_id, client_mutation_id, actor_id, expected_revision, revision, request_digest, saved_at)
            SELECT id, {clientMutationId}, {project.ActorId}, {expectedRevision}, revision, {requestDigest}, updated_at
            FROM projects WHERE id = {project.ProjectId}
            """, cancellationToken);
        if (inserted != 1)
        {
            throw new InvalidOperationException("A staged draft must have exactly one save receipt.");
        }
        return true;
    }
}
