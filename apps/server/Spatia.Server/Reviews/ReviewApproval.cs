using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Reviews;

internal enum ReviewApprovalState
{
    UnverifiedOrigin,
    ApprovalRequired,
    Approved,
    StaleProject,
}

/// <summary>Checks known class work without deciding the deferred policy for unverified origins.</summary>
internal static class ReviewApproval
{
    /// <remarks>The caller must first reauthorize the actor for publication in this same transaction.</remarks>
    internal static async Task<ReviewApprovalState> CheckLockedAsync(ApplicationDbContext database,
        ProjectAccessSnapshot project, CancellationToken cancellationToken = default)
    {
        if (database.Database.CurrentTransaction?.GetDbTransaction().IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw new InvalidOperationException("Review approval requires a caller-owned read-committed transaction.");
        }
        var locked = await database.Database.SqlQuery<long>($"""
            SELECT revision AS "Value" FROM projects
            WHERE id = {project.ProjectId} AND organization_id = {project.OrganizationId}
                AND revision = {project.Revision} AND archived = {project.IsArchived}
            FOR UPDATE
            """).ToListAsync(cancellationToken);
        if (locked.Count != 1 || project.IsArchived) { return ReviewApprovalState.StaleProject; }
        if (!await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == project.ProjectId, cancellationToken))
        {
            return ReviewApprovalState.UnverifiedOrigin;
        }
        var latest = await database.ReviewSubmissions.AsNoTracking().Where(row => row.ProjectId == project.ProjectId)
            .OrderByDescending(row => row.Sequence).Select(row => new { row.Id, row.SourceRevision })
            .FirstOrDefaultAsync(cancellationToken);
        if (latest is null || latest.SourceRevision != project.Revision) { return ReviewApprovalState.ApprovalRequired; }
        var outcome = await database.ReviewDecisions.AsNoTracking().Where(row => row.SubmissionId == latest.Id)
            .OrderByDescending(row => row.Sequence).Select(row => row.Outcome).FirstOrDefaultAsync(cancellationToken);
        return outcome == ReviewDecision.Approved ? ReviewApprovalState.Approved : ReviewApprovalState.ApprovalRequired;
    }
}
