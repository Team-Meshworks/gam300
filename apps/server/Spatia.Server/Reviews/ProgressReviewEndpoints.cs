using System.Data;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Reviews;

/// <summary>Private feedback on a saved student project, independent of submission decisions.</summary>
public static class ProgressReviewEndpoints
{
    /// <summary>Maps project feedback reads and writes.</summary>
    public static IEndpointRouteBuilder MapProgressReviews(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/projects/{id:guid}/progress-reviews", ListAsync).RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapPost("/projects/{id:guid}/progress-reviews", AddAsync).RequireAuthorization(SecurityPolicies.FullAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        return endpoints;
    }

    private static async Task<IResult> ListAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!ClassroomEndpoints.TryPage(context, out var limit, out var cursor))
        { return ApiProblems.Create(context, 400, "invalid_review_query", "Check the review list filters and cursor."); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        if (account.Role is not (ApplicationRoles.Creator or ApplicationRoles.Educator)) { return Unavailable(context); }
        var mapping = await database.ClassAssignmentStudents.AsNoTracking().SingleOrDefaultAsync(row => row.ProjectId == id, cancellationToken);
        if (mapping is null || (account.Role == ApplicationRoles.Creator && mapping.StudentId != account.UserId)
            || !await access.VisibleProjects(account).AnyAsync(row => row.Id == id, cancellationToken)) { return Unavailable(context); }
        var query = database.ProgressReviews.AsNoTracking().Where(row => row.ProjectId == id);
        if (cursor is { } after) { query = query.Where(row => row.Id.CompareTo(after) > 0); }
        var rows = await query.OrderBy(row => row.Id).Take(limit + 1)
            .Select(row => new { row.Id, row.Feedback, row.CreatedAt, row.Revision }).ToArrayAsync(cancellationToken);
        var page = rows.Take(limit).ToArray();
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            Results.Ok(new { items = page, nextCursor = rows.Length > limit ? page[^1].Id : (Guid?)null }), cancellationToken);
    }

    private static async Task<IResult> AddAsync(Guid id, ProgressReviewRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (request.ReviewId is not { } reviewId || reviewId == Guid.Empty
            || request.ExpectedRevision is not (>= 0 and <= Project.MaxRevision)
            || string.IsNullOrWhiteSpace(request.Feedback) || request.Feedback.Length > 4000 || request.Feedback.Contains('\0'))
        { return ApiProblems.Create(context, 400, "invalid_progress_review", "Check the review text and saved revision."); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, id, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.Role != ApplicationRoles.Educator) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden); }
        if (!await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == id, cancellationToken)) { return Unavailable(context); }
        var existing = await database.ProgressReviews.AsNoTracking().SingleOrDefaultAsync(row => row.Id == reviewId, cancellationToken);
        if (existing is not null)
        {
            if (existing.ProjectId != id || existing.EducatorId != account.UserId || existing.Revision != request.ExpectedRevision
                || existing.Feedback != request.Feedback) { return Conflict(context); }
            return await ClassroomEndpoints.CompleteAsync(context, transaction, Results.Ok(Acknowledgement(existing)), cancellationToken);
        }
        if (authorization.Snapshot!.Revision != request.ExpectedRevision)
        { return ProjectHttpResults.FromSave(context, ProjectSaveResult.Rejected(ProjectSaveDecision.Conflict, authorization.Snapshot.Revision)); }
        var review = new ProgressReview
        {
            Id = reviewId,
            ProjectId = id,
            EducatorId = account.UserId,
            Revision = request.ExpectedRevision.Value,
            Feedback = request.Feedback
        };
        database.ProgressReviews.Add(review);
        try { await database.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateException error) when (error.InnerException is Npgsql.PostgresException
        { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation, ConstraintName: "PK_progress_reviews" })
        { return Conflict(context); }
        var current = await access.LockAsync(context, id, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (current.Failure is { } currentFailure) { return ProjectHttpResults.FromAccessFailure(context, currentFailure); }
        var currentAccount = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (currentAccount?.UserId != account.UserId || currentAccount.Role != ApplicationRoles.Educator)
        { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden); }
        return await ClassroomEndpoints.CompleteAsync(context, transaction, Results.Json(Acknowledgement(review), statusCode: 201), cancellationToken);
    }

    private static object Acknowledgement(ProgressReview row) => new { row.Id, row.Feedback, row.CreatedAt, row.Revision };
    private static IResult Unavailable(HttpContext context) => ApiProblems.Create(context, 404, "review_not_found", "The review is unavailable.");
    private static IResult Conflict(HttpContext context) => ApiProblems.Create(context, 409, "progress_review_conflict", "The review could not be reconciled.");
    private sealed record ProgressReviewRequest(Guid? ReviewId, [property: JsonNumberHandling(JsonNumberHandling.Strict)] long? ExpectedRevision, string? Feedback);
}
