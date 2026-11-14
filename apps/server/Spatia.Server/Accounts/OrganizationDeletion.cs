using System.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

public static partial class AccountDirectoryEndpoints
{
    private sealed class DeleteOrganizationRequest
    {
        public required string ConfirmationName { get; init; }
    }

    private static async Task<IResult> GetOrganizationDeletionAsync(Guid id, HttpContext context,
        ApplicationDbContext database, CurrentAccountResolver accounts, CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var organization = await database.Organizations.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id, cancellationToken);
        if (organization is null) { return OrganizationNotFound(context); }
        var projects = database.Projects.Where(row => row.OrganizationId == id).Select(row => row.Id);
        var submissions = database.ReviewSubmissions.Where(row => projects.Contains(row.ProjectId)).Select(row => row.Id);
        var summary = new
        {
            organization.Id,
            organization.Name,
            accounts = await database.OrganizationMemberships.CountAsync(row => row.OrganizationId == id, cancellationToken),
            classes = await database.Classrooms.CountAsync(row => row.OrganizationId == id, cancellationToken),
            assignments = await database.ClassAssignments.CountAsync(row => row.OrganizationId == id, cancellationToken),
            projects = await projects.CountAsync(cancellationToken),
            submissions = await submissions.CountAsync(cancellationToken),
            reviews = await database.ReviewDecisions.CountAsync(row => submissions.Contains(row.SubmissionId), cancellationToken),
            publications = await database.Publications.CountAsync(row => projects.Contains(row.ProjectId), cancellationToken),
        };
        return await CompleteAsync(context, transaction, Results.Ok(summary), cancellationToken);
    }

    private static async Task<IResult> DeleteOrganizationAsync(Guid id, [FromBody] DeleteOrganizationRequest request,
        HttpContext context, ApplicationDbContext database, CurrentAccountResolver accounts, CancellationToken cancellationToken)
    {
        if (request.ConfirmationName is null or { Length: 0 or > 256 })
        {
            return ApiProblems.Create(context, 400, "organization_confirmation_required", "Enter the organisation name to confirm deletion.");
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            // Match provisioning/role-change lock order, then block new children of this organisation.
            await database.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE", cancellationToken);
            var organization = await database.Organizations.FromSqlInterpolated(
                $"SELECT * FROM organizations WHERE id = {id} FOR UPDATE").SingleOrDefaultAsync(cancellationToken);
            if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
            if (organization is null) { return OrganizationNotFound(context); }
            if (!string.Equals(request.ConfirmationName, organization.Name, StringComparison.Ordinal))
            {
                return ApiProblems.Create(context, 400, "organization_confirmation_required", "The confirmation must match the organisation name exactly.");
            }
            var memberIds = await database.OrganizationMemberships.Where(row => row.OrganizationId == id)
                .Select(row => row.UserId).ToArrayAsync(cancellationToken);
            // Project writers also lock these rows. Never delete a snapshot while its writer is active.
            await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM projects WHERE organization_id = {id} ORDER BY id FOR UPDATE")
                .ToListAsync(cancellationToken);
            await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM classrooms WHERE organization_id = {id} ORDER BY id FOR UPDATE")
                .ToListAsync(cancellationToken);
            var projectIds = database.Projects.Where(row => row.OrganizationId == id).Select(row => row.Id);
            var submissionIds = database.ReviewSubmissions.Where(row => projectIds.Contains(row.ProjectId)).Select(row => row.Id);
            var publicationIds = database.Publications.Where(row => projectIds.Contains(row.ProjectId)).Select(row => row.Id);

            // This transaction-local scope permits DELETE only for this organisation's immutable evidence.
            // Ordinary edits/deletes remain forbidden; publication IDs are permanently retired by the trigger.
            await database.Database.ExecuteSqlInterpolatedAsync($"SELECT set_config('spatia.purge_organization', {id.ToString("D")}, true)", cancellationToken);
            await database.ReviewDecisions.Where(row => submissionIds.Contains(row.SubmissionId)).ExecuteDeleteAsync(cancellationToken);
            await database.ProgressReviews.Where(row => projectIds.Contains(row.ProjectId)).ExecuteDeleteAsync(cancellationToken);
            await database.ReviewSubmissions.Where(row => projectIds.Contains(row.ProjectId)).ExecuteDeleteAsync(cancellationToken);
            await database.PublicationAccess.Where(row => publicationIds.Contains(row.PublicationId)).ExecuteDeleteAsync(cancellationToken);
            // Remove only this organization's links; globally shared built-in blobs remain immutable.
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                DELETE FROM development_publication_assets
                WHERE publication_id = ANY({publicationIds})
                """, cancellationToken);
            await database.Publications.Where(row => projectIds.Contains(row.ProjectId)).ExecuteDeleteAsync(cancellationToken);
            await database.ProjectProvenances.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);
            await database.ClassAssignmentStudents.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);
            await database.ClassAssignments.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);
            await database.ClassroomMembers.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);
            await database.Classrooms.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);
            await database.ProjectSaveReceipts.Where(row => projectIds.Contains(row.ProjectId)).ExecuteDeleteAsync(cancellationToken);
            await database.ProjectAssignments.Where(row => projectIds.Contains(row.ProjectId) || memberIds.Contains(row.UserId)).ExecuteDeleteAsync(cancellationToken);
            await database.Projects.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);

            // Remove access references to deleted identities without changing another organisation's content.
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE publication_access SET "ViewerIds" = ARRAY(
                    SELECT viewer FROM unnest("ViewerIds") AS viewer WHERE NOT (viewer = ANY ({memberIds})))
                WHERE "ViewerIds" && {memberIds}
                """, cancellationToken);
            await database.OrganizationMemberships.Where(row => row.OrganizationId == id).ExecuteDeleteAsync(cancellationToken);
            // Identity's child rows cascade; platform administrators do not belong to organisations.
            await database.Users.Where(row => memberIds.Contains(row.Id)).ExecuteDeleteAsync(cancellationToken);
            await database.Organizations.Where(row => row.Id == id).ExecuteDeleteAsync(cancellationToken);
            if (await AuthorizeAsync(context, accounts, cancellationToken) is { } revoked) { return revoked; }
            return await CompleteAsync(context, transaction, Results.NoContent(), cancellationToken);
        }
        catch (PostgresException exception) when (exception.SqlState is PostgresErrorCodes.ForeignKeyViolation or PostgresErrorCodes.RestrictViolation
            or PostgresErrorCodes.DeadlockDetected or PostgresErrorCodes.SerializationFailure)
        {
            return ApiProblems.Create(context, 409, "organization_delete_conflict",
                "Deletion was rolled back because records changed or are linked outside this organisation. Refresh before trying again.");
        }
    }

    private static IResult OrganizationNotFound(HttpContext context) =>
        ApiProblems.Create(context, 404, "organization_not_found", "The organisation was not found.");
}
