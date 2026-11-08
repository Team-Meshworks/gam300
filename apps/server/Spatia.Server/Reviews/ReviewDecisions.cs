using System.Data;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Reviews;

internal static class ReviewDecisions
{
    internal static async Task<IResult> DecideAsync(Guid id, Guid submissionId, DecisionRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (submissionId == Guid.Empty || request.DecisionId is not { } decisionId || decisionId == Guid.Empty
            || request.ExpectedRevision is not (>= 0 and <= Project.MaxRevision)
            || request.Outcome is not (ReviewDecision.Approved or ReviewDecision.Returned or ReviewDecision.Revoked)
            || request.Feedback is null || request.Feedback.Length > 4000 || request.Feedback.Contains('\0'))
        {
            return ApiProblems.Create(context, 400, "invalid_review_decision", "Check the review decision and feedback.");
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, id, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var project = authorization.Snapshot!;
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.Role != ApplicationRoles.Educator)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        if (!await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == id, cancellationToken)) { return Unavailable(context); }
        var digest = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = 1,
            projectId = id,
            submissionId,
            educatorId = account.UserId,
            request.ExpectedRevision,
            request.Outcome,
            request.Feedback,
        }));
        var existing = await database.ReviewDecisions.AsNoTracking().SingleOrDefaultAsync(row => row.Id == decisionId, cancellationToken);
        if (existing is not null)
        {
            if (existing.SubmissionId != submissionId || existing.EducatorId != account.UserId
                || !CryptographicOperations.FixedTimeEquals(existing.RequestDigest, digest)) { return Conflict(context); }
            return await ClassroomEndpoints.CompleteAsync(context, transaction, Results.Ok(Acknowledgement(existing)), cancellationToken);
        }
        var latest = await database.ReviewSubmissions.AsNoTracking().Where(row => row.ProjectId == id)
            .OrderByDescending(row => row.Sequence).Select(row => new { row.Id, row.SourceRevision })
            .FirstOrDefaultAsync(cancellationToken);
        if (latest is null || latest.Id != submissionId) { return Conflict(context); }
        if (latest.SourceRevision != project.Revision || request.ExpectedRevision != project.Revision)
        {
            return ProjectHttpResults.FromSave(context, ProjectSaveResult.Rejected(ProjectSaveDecision.Conflict, project.Revision));
        }
        var previous = await database.ReviewDecisions.AsNoTracking().Where(row => row.SubmissionId == submissionId)
            .OrderByDescending(row => row.Sequence).Select(row => new { row.Sequence, row.Outcome })
            .FirstOrDefaultAsync(cancellationToken);
        if (previous?.Sequence == long.MaxValue || previous?.Outcome is ReviewDecision.Returned or ReviewDecision.Revoked
            || (request.Outcome == ReviewDecision.Revoked && previous?.Outcome != ReviewDecision.Approved))
        {
            return Conflict(context);
        }
        var decision = new ReviewDecision
        {
            Id = decisionId,
            SubmissionId = submissionId,
            EducatorId = account.UserId,
            Sequence = (previous?.Sequence ?? 0) + 1,
            Outcome = request.Outcome,
            Feedback = request.Feedback,
            RequestDigest = digest,
        };
        database.ReviewDecisions.Add(decision);
        try { await database.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateException error) when (error.InnerException is PostgresException
        { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "PK_review_decisions" })
        {
            return Conflict(context);
        }
        var current = await access.LockAsync(context, id, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (current.Failure is { } currentFailure) { return ProjectHttpResults.FromAccessFailure(context, currentFailure); }
        var currentAccount = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (currentAccount is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (currentAccount.Role != ApplicationRoles.Educator)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        if (request.Outcome == ReviewDecision.Approved)
        {
            await database.ProjectAssignments.Where(grant => grant.ProjectId == id && grant.CanEdit
                && database.ClassAssignmentStudents.Any(student => student.ProjectId == id
                    && student.StudentId == grant.UserId && student.IsActive))
                .ExecuteUpdateAsync(update => update.SetProperty(grant => grant.CanPublish, true), cancellationToken);
        }
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            Results.Json(Acknowledgement(decision), statusCode: 201), cancellationToken);
    }

    private static object Acknowledgement(ReviewDecision decision) => new
    {
        decisionId = decision.Id,
        decision.SubmissionId,
        decision.Sequence,
        decision.Outcome,
        decision.Feedback,
        decision.DecidedAt,
    };

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "review_not_found", "The review is unavailable.");
    private static IResult Conflict(HttpContext context) =>
        ApiProblems.Create(context, 409, "review_decision_conflict", "The review decision could not be reconciled.");

    internal sealed record DecisionRequest(Guid? DecisionId, [property: JsonNumberHandling(JsonNumberHandling.Strict)] long? ExpectedRevision,
        string? Outcome, string? Feedback);
}
