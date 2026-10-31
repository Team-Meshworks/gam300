using System.Data;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Reviews;

internal static class ReviewReads
{
    internal static Task<IResult> ListAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken) =>
        ReadAsync(id, null, context, database, access, cancellationToken);

    internal static Task<IResult> GetAsync(Guid id, Guid submissionId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken) =>
        ReadAsync(id, submissionId, context, database, access, cancellationToken);

    private static async Task<IResult> ReadAsync(Guid id, Guid? submissionId, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!ClassroomEndpoints.TryPage(context, out var limit, out var cursor))
        {
            return ApiProblems.Create(context, 400, "invalid_review_query", "Check the review list filters and cursor.");
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        if (account.Role is not (ApplicationRoles.Creator or ApplicationRoles.Educator)) { return Unavailable(context); }
        var project = await access.VisibleProjects(account).Where(row => row.Id == id)
            .Select(row => new { row.Revision }).SingleOrDefaultAsync(cancellationToken);
        if (project is null || !await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == id, cancellationToken))
        {
            return Unavailable(context);
        }
        var latestSequence = await database.ReviewSubmissions.Where(row => row.ProjectId == id)
            .Select(row => (long?)row.Sequence).MaxAsync(cancellationToken);
        if (submissionId is null)
        {
            var query = database.ReviewSubmissions.AsNoTracking().Where(row => row.ProjectId == id);
            if (cursor is { } after) { query = query.Where(row => row.Id.CompareTo(after) > 0); }
            var rows = await query.OrderBy(row => row.Id).Take(limit + 1)
                .Select(row => new { row.Id, row.SourceRevision, row.Sequence, row.SubmittedAt, row.DueAtUnixSeconds })
                .ToArrayAsync(cancellationToken);
            var page = rows.Take(limit).ToArray();
            var items = page.Select(row => new
            {
                submissionId = row.Id,
                revision = row.SourceRevision,
                row.Sequence,
                row.SubmittedAt,
                row.DueAtUnixSeconds,
                isLate = ReviewDeadline.IsLate(row.SubmittedAt, row.DueAtUnixSeconds),
                isCurrentSubmission = row.Sequence == latestSequence && row.SourceRevision == project.Revision,
            }).ToArray();
            return await ClassroomEndpoints.CompleteAsync(context, transaction,
                Results.Ok(new { items, nextCursor = rows.Length > limit ? page[^1].Id : (Guid?)null }), cancellationToken);
        }
        var submission = await database.ReviewSubmissions.AsNoTracking()
            .SingleOrDefaultAsync(row => row.Id == submissionId && row.ProjectId == id, cancellationToken);
        if (submission is null) { return Unavailable(context); }
        var decisions = database.ReviewDecisions.AsNoTracking().Where(row => row.SubmissionId == submission.Id);
        if (cursor is { } afterDecision) { decisions = decisions.Where(row => row.Id.CompareTo(afterDecision) > 0); }
        var decisionRows = await decisions.OrderBy(row => row.Id).Take(limit + 1)
            .Select(row => new { row.Id, row.EducatorId, row.Sequence, row.Outcome, row.Feedback, row.DecidedAt })
            .ToArrayAsync(cancellationToken);
        var latestDecision = await database.ReviewDecisions.AsNoTracking().Where(row => row.SubmissionId == submission.Id)
            .OrderByDescending(row => row.Sequence)
            .Select(row => new { row.Id, row.EducatorId, row.Sequence, row.Outcome, row.Feedback, row.DecidedAt })
            .FirstOrDefaultAsync(cancellationToken);
        var decisionPage = decisionRows.Take(limit).ToArray();
        using var document = JsonDocument.Parse(submission.DocumentJson);
        using var assets = JsonDocument.Parse(submission.AssetReferencesJson);
        return await ClassroomEndpoints.CompleteAsync(context, transaction, Results.Ok(new
        {
            submissionId = submission.Id,
            submission.ProjectId,
            submission.StudentId,
            revision = submission.SourceRevision,
            submission.Sequence,
            submission.SubmittedAt,
            submission.DueAtUnixSeconds,
            isLate = ReviewDeadline.IsLate(submission.SubmittedAt, submission.DueAtUnixSeconds),
            isCurrentSubmission = submission.Sequence == latestSequence && submission.SourceRevision == project.Revision,
            document = document.RootElement.Clone(),
            assetReferences = assets.RootElement.Clone(),
            latestDecision,
            decisions = decisionPage,
            nextCursor = decisionRows.Length > limit ? decisionPage[^1].Id : (Guid?)null,
        }), cancellationToken);
    }

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "review_not_found", "The review is unavailable.");
}
