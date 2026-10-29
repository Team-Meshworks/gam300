using System.Data;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

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
        var (_, failure) = await ClassroomEndpoints.FindAsync(id, context, database, access, false, false, cancellationToken);
        if (failure is not null) { return failure; }
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }

        var visibleProjects = access.VisibleProjects(account);
        var mappings = database.ClassAssignmentStudents.AsNoTracking().Where(row => row.ClassroomId == id
            && visibleProjects.Any(project => project.Id == row.ProjectId));
        var assignments = database.ClassAssignments.AsNoTracking().Where(row => row.ClassroomId == id
            && mappings.Any(mapping => mapping.AssignmentId == row.Id));
        if (assignmentId is { } exact) { assignments = assignments.Where(row => row.Id == exact); }
        else if (cursor is { } after) { assignments = assignments.Where(row => row.Id.CompareTo(after) > 0); }
        var rows = await assignments.OrderBy(row => row.Id).Take(assignmentId is null ? limit + 1 : 1)
            .Select(row => new { row.Id, row.Title, row.Description, row.Instructions, row.DueAtUnixSeconds })
            .ToArrayAsync(cancellationToken);
        var page = rows.Take(limit).ToArray();
        var ids = page.Select(row => row.Id).ToArray();
        var projects = await mappings.Where(row => ids.Contains(row.AssignmentId))
            .OrderBy(row => row.StudentId)
            .Select(row => new { row.AssignmentId, row.StudentId, row.ProjectId }).ToArrayAsync(cancellationToken);
        var items = page.Select(row => new AssignmentView(row.Id, row.Title, row.Description, row.Instructions, row.DueAtUnixSeconds,
            projects.Where(project => project.AssignmentId == row.Id)
                .Select(project => new StudentProject(project.StudentId, project.ProjectId)).ToArray())).ToArray();
        if (assignmentId is not null && items.Length == 0)
        {
            return ApiProblems.Create(context, 404, "class_assignment_not_found", "The assignment is unavailable.");
        }
        var nextCursor = assignmentId is null && rows.Length > limit ? page[^1].Id : (Guid?)null;
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            assignmentId is null ? Results.Ok(new { items, nextCursor }) : Results.Ok(items[0]), cancellationToken);
    }

    private sealed record AssignmentView(Guid AssignmentId, string Title, string Description, string Instructions,
        long DueAtUnixSeconds, StudentProject[] Projects);
    private sealed record StudentProject(Guid StudentId, Guid ProjectId);
}
