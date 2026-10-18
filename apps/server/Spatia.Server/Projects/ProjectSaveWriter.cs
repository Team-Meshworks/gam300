using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Persistence;

namespace Spatia.Server.Projects;

public sealed class ProjectSaveWriter(ApplicationDbContext database)
{
    /// <summary>Stages one conditional draft update; true means staged, never committed or acknowledged</summary>
    /// <remarks>The caller must validate input, obtain an EditDraft lock and retain its transaction through commit or rollback</remarks>
    // TODO: Wire a production caller only after SCRUM-50 validation and server-side digest generation are integrated
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
