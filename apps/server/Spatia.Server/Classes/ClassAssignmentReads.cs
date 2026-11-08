using System.Data;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;
using Spatia.Server.Publications;

namespace Spatia.Server.Classes;

internal static class ClassAssignmentReads
{
    internal static Task<IResult> ListAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken) =>
        ReadAsync(id, null, context, database, access, cancellationToken);

    internal static Task<IResult> GetAsync(Guid id, Guid assignmentId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken) =>
        ReadAsync(id, assignmentId, context, database, access, cancellationToken);

    private static async Task<IResult> ReadAsync(Guid id, Guid? assignmentId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        var limit = 10;
        Guid? cursor = null;
        if (assignmentId is null)
        {
            if (!ClassroomEndpoints.TryPage(context, out limit, out cursor)) { return ClassroomEndpoints.InvalidQuery(context); }
        }
        else if (context.Request.Query.Count != 0) { return ClassroomEndpoints.InvalidQuery(context); }

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var (classroom, failure) = await ClassroomEndpoints.FindAsync(id, context, database, access, false, false, cancellationToken);
        if (failure is not null) { return failure; }
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }

        var visibleProjects = access.VisibleProjects(account);
        var mappings = database.ClassAssignmentStudents.AsNoTracking().Where(row => row.ClassroomId == id && row.IsActive
            && visibleProjects.Any(project => project.Id == row.ProjectId));
        var assignments = database.ClassAssignments.AsNoTracking().Where(row => row.ClassroomId == id
            && mappings.Any(mapping => mapping.AssignmentId == row.Id));
        if (assignmentId is { } exact) { assignments = assignments.Where(row => row.Id == exact); }
        else if (cursor is { } after) { assignments = assignments.Where(row => row.Id.CompareTo(after) > 0); }
        var rows = await assignments.OrderBy(row => row.Id).Take(assignmentId is null ? limit + 1 : 1)
            .Select(row => new { row.Id, row.Title, row.Description, row.Instructions, row.DueAtUnixSeconds, row.Revision, row.SourceProjectId, row.CreatedByUserId })
            .ToArrayAsync(cancellationToken);
        var page = rows.Take(limit).ToArray();
        var ids = page.Select(row => row.Id).ToArray();
        var sourceIds = page.Select(row => row.SourceProjectId).ToArray();
        var creatorIds = page.Select(row => row.CreatedByUserId).Distinct().ToArray();
        var creators = await database.Users.AsNoTracking().Where(user => creatorIds.Contains(user.Id))
            .Select(user => new { user.Id, Name = string.IsNullOrEmpty(user.DisplayName) ? user.UserName : user.DisplayName }).ToArrayAsync(cancellationToken);
        var organizationName = await database.Organizations.AsNoTracking().Where(org => org.Id == classroom!.OrganizationId)
            .Select(org => org.Name).SingleAsync(cancellationToken);
        var creator = account.Role == ApplicationRoles.Creator;
        var visibleSources = creator ? [] : await visibleProjects
            .Where(project => sourceIds.Contains(project.Id)).Select(project => project.Id).ToArrayAsync(cancellationToken);
        var projects = await (from mapping in mappings
                              join student in database.Users.AsNoTracking() on mapping.StudentId equals student.Id
                              where ids.Contains(mapping.AssignmentId)
                              orderby mapping.StudentId
                              select new
                              {
                                  mapping.AssignmentId,
                                  mapping.StudentId,
                                  mapping.ProjectId,
                                  StudentName = string.IsNullOrEmpty(student.DisplayName)
                                      ? student.UserName ?? student.Id.ToString()
                                      : student.DisplayName + " (" + (student.UserName ?? student.Id.ToString()) + ")",
                              }).ToArrayAsync(cancellationToken);
        var projectIds = projects.Where(row => !creator || row.StudentId == account.UserId).Select(row => row.ProjectId).ToArray();
        var retired = database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids");
        var statusRows = await visibleProjects.Where(project => projectIds.Contains(project.Id))
            .Select(project => new
            {
                project.Id,
                project.Revision,
                Submission = database.ReviewSubmissions.Where(submission => submission.ProjectId == project.Id)
                    .OrderByDescending(submission => submission.Sequence)
                    .Select(submission => new
                    {
                        submission.Id,
                        submission.SourceRevision,
                        Outcome = database.ReviewDecisions.Where(decision => decision.SubmissionId == submission.Id)
                            .OrderByDescending(decision => decision.Sequence).Select(decision => decision.Outcome).FirstOrDefault()
                    }).FirstOrDefault(),
                Published = !creator && !project.IsArchived && (from publication in database.Publications
                                                    join policy in database.PublicationAccess on publication.Id equals policy.PublicationId
                                                    where publication.ProjectId == project.Id && !policy.Hidden && !policy.Revoked && !policy.Deleted
                                                        && !retired.Contains(publication.Id)
                                                    select publication.Id).Any(),
                IsPublic = !creator && !project.IsArchived && (from publication in database.Publications
                                                   join policy in database.PublicationAccess on publication.Id equals policy.PublicationId
                                                   where publication.ProjectId == project.Id && !policy.Hidden && !policy.Revoked && !policy.Deleted
                                                       && !retired.Contains(publication.Id)
                                                       && (policy.Audience == (int)PublicationAudience.Public || policy.Audience == (int)PublicationAudience.Unlisted)
                                                   select publication.Id).Any(),
            }).ToArrayAsync(cancellationToken);
        var items = page.Select(row => new AssignmentView(row.Id, row.Title, row.Description, row.Instructions, row.DueAtUnixSeconds, row.Revision,
            organizationName, creators.FirstOrDefault(user => user.Id == row.CreatedByUserId)?.Name ?? "Teacher",
            visibleSources.Contains(row.SourceProjectId) ? row.SourceProjectId : null,
            projects.Where(project => project.AssignmentId == row.Id)
                .Select(project =>
                {
                    var status = statusRows.FirstOrDefault(item => item.Id == project.ProjectId);
                    var approval = status is null ? null : status.Submission is null ? "not-submitted"
                        : status.Submission.SourceRevision != status.Revision ? "changes-since-submission"
                        : status.Submission.Outcome switch
                        {
                            ReviewDecision.Approved => "approved",
                            ReviewDecision.Returned => "returned",
                            ReviewDecision.Revoked => "revoked",
                            _ => "awaiting-approval",
                        };
                    var reviewState = account.Role == ApplicationRoles.Administrator ? null : approval switch
                    {
                        "not-submitted" => "draft",
                        "changes-since-submission" => "outdated",
                        "awaiting-approval" => "pending",
                        _ => approval,
                    };
                    return new StudentProject(project.StudentId, project.ProjectId, project.StudentName, reviewState,
                        creator ? null : approval, creator ? null : status?.Published,
                        account.Role == ApplicationRoles.Administrator ? status?.IsPublic : null);
                }).ToArray())).ToArray();
        if (assignmentId is not null && items.Length == 0)
        {
            return ApiProblems.Create(context, 404, "class_assignment_not_found", "The assignment is unavailable.");
        }
        var nextCursor = assignmentId is null && rows.Length > limit ? page[^1].Id : (Guid?)null;
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            assignmentId is null ? Results.Ok(new { items, nextCursor }) : Results.Ok(items[0]), cancellationToken);
    }

    private sealed record AssignmentView(Guid AssignmentId, string Title, string Description, string Instructions,
        long DueAtUnixSeconds, long Revision, string OrganizationName, string CreatorName,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Guid? SourceProjectId, StudentProject[] Projects)
    {
        public string AssignedBy => CreatorName;
    }
    private sealed record StudentProject(Guid StudentId, Guid ProjectId, string StudentName, string? ReviewState,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ApprovalStatus,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Published,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IsPublic);
}
