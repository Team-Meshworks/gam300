using System.Collections.Frozen;
using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Reviews;

/// <summary>Maps submission of a confirmed saved class draft.</summary>
public static class ReviewSubmissionEndpoints
{
    /// <summary>Adds the authorized, retry-safe student submission route.</summary>
    public static IEndpointRouteBuilder MapReviewSubmissions(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/projects/{id:guid}/submissions", SubmitAsync)
            .RequireAuthorization(SecurityPolicies.FullAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        endpoints.MapGet("/projects/{id:guid}/submissions", ReviewReads.ListAsync)
            .RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapGet("/projects/{id:guid}/submissions/{submissionId:guid}", ReviewReads.GetAsync)
            .RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapPost("/projects/{id:guid}/submissions/{submissionId:guid}/decisions", ReviewDecisions.DecideAsync)
            .RequireAuthorization(SecurityPolicies.FullAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        return endpoints;
    }

    private static async Task<IResult> SubmitAsync(Guid id, SubmissionRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents,
        IReviewAssetResolver assets, CancellationToken cancellationToken)
    {
        if (request.SubmissionId is not { } submissionId || submissionId == Guid.Empty
            || request.ExpectedRevision is not (>= 0 and <= Project.MaxRevision) || request.CompletionConfirmed != true)
        {
            return ApiProblems.Create(context, 400, "invalid_submission_input", "Confirm completion and supply a valid saved revision.");
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, id, ProjectLockPurpose.EditDraft, cancellationToken);
        if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var project = authorization.Snapshot!;
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.Role != ApplicationRoles.Creator)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        var mapping = await (from student in database.ClassAssignmentStudents.AsNoTracking()
                             join assignment in database.ClassAssignments.AsNoTracking() on student.AssignmentId equals assignment.Id
                             where student.ProjectId == id && student.StudentId == account.UserId
                             select new { student.StudentId, assignment.DueAtUnixSeconds }).SingleOrDefaultAsync(cancellationToken);
        if (mapping is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(
            $"spatia-review-submit-v1\n{id:D}\n{account.UserId:D}\n{request.ExpectedRevision.Value.ToString(CultureInfo.InvariantCulture)}\ntrue"));
        var existing = await database.ReviewSubmissions.AsNoTracking().SingleOrDefaultAsync(row => row.Id == submissionId, cancellationToken);
        if (existing is not null)
        {
            if (existing.ProjectId != id || existing.StudentId != account.UserId
                || !CryptographicOperations.FixedTimeEquals(existing.RequestDigest, digest)) { return Conflict(context); }
            return await ClassroomEndpoints.CompleteAsync(context, transaction, Results.Ok(Acknowledgement(existing)), cancellationToken);
        }
        if (request.ExpectedRevision != project.Revision)
        {
            return ProjectHttpResults.FromSave(context, ProjectSaveResult.Rejected(ProjectSaveDecision.Conflict, project.Revision));
        }
        var document = documents.ReadStored(id, project.SchemaVersion, project.UnvalidatedDocumentJson);
        if (!document.Ok) { return ApiProblems.Create(context, 503, "project_unavailable", "The project is unavailable."); }
        var required = ReviewAssetManifest.Required(document.Value!).ToFrozenSet(StringComparer.Ordinal);
        var references = await assets.ResolveAsync(database, project, required, cancellationToken);
        var manifest = ReviewAssetManifest.Serialize(required, references);
        if (manifest is null)
        {
            return ApiProblems.Create(context, 503, "review_assets_unavailable", "The submitted assets are unavailable.");
        }
        var previous = await database.ReviewSubmissions.Where(row => row.ProjectId == id)
            .Select(row => (long?)row.Sequence).MaxAsync(cancellationToken) ?? 0;
        if (previous == long.MaxValue) { return Conflict(context); }
        var submission = new ReviewSubmission
        {
            Id = submissionId,
            ProjectId = id,
            StudentId = account.UserId,
            Sequence = previous + 1,
            SourceRevision = project.Revision,
            DueAtUnixSeconds = mapping.DueAtUnixSeconds,
            SchemaVersion = document.Value!.SchemaVersion,
            CompletionConfirmed = true,
            DocumentJson = project.UnvalidatedDocumentJson,
            AssetReferencesJson = manifest,
            RequestDigest = digest,
        };
        database.ReviewSubmissions.Add(submission);
        try { await database.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateException error) when (error.InnerException is PostgresException
        { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "PK_review_submissions" })
        {
            return Conflict(context);
        }
        var current = await access.LockAsync(context, id, ProjectLockPurpose.EditDraft, cancellationToken);
        if (current.Failure is { } currentFailure) { return ProjectHttpResults.FromAccessFailure(context, currentFailure); }
        var currentAccount = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (currentAccount is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (currentAccount.Role != ApplicationRoles.Creator)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            Results.Json(Acknowledgement(submission), statusCode: 201), cancellationToken);
    }

    private static object Acknowledgement(ReviewSubmission submission) => new
    {
        submissionId = submission.Id,
        submission.ProjectId,
        revision = submission.SourceRevision,
        submission.SubmittedAt,
        submission.DueAtUnixSeconds,
        isLate = ReviewDeadline.IsLate(submission.SubmittedAt, submission.DueAtUnixSeconds),
    };

    private static IResult Conflict(HttpContext context) =>
        ApiProblems.Create(context, 409, "submission_conflict", "The submission could not be reconciled.");

    private sealed record SubmissionRequest(Guid? SubmissionId,
        [property: JsonNumberHandling(JsonNumberHandling.Strict)] long? ExpectedRevision, bool? CompletionConfirmed);
}
