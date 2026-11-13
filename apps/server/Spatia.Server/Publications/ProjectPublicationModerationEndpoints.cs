using System.Data;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;
using Spatia.Server.Reviews;

namespace Spatia.Server.Publications;

// Moderate existing editions without rewriting the draft or immutable publication history
internal static class ProjectPublicationModerationEndpoints
{
    internal sealed record ModerationRequest(string Action);
    private sealed record SelectionRequest(Guid[] ProjectIds, string Action);

    public static IEndpointRouteBuilder MapProjectPublicationModeration(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/admin/projects").RequireAuthorization(SecurityPolicies.Administrator);
        group.MapPost("/publication-moderation", (SelectionRequest request, HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) => ChangeManyAsync(request, context, database, access, token, false))
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit).WithMetadata(new RequestSizeLimitAttribute(64 * 1024));
        group.MapGet("/publication-moderation", (HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) => ReadAsync(context, database, access, token, false));
        group.MapPost("/{projectId:guid}/publication-moderation", (Guid projectId, ModerationRequest request, HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) => ChangeAsync(projectId, request, context, database, access, token, false))
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute(4 * 1024));
        var facilitator = endpoints.MapGroup("/projects").RequireAuthorization(SecurityPolicies.FullAccount);
        facilitator.MapPost("/publication-moderation", (SelectionRequest request, HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) => ChangeManyAsync(request, context, database, access, token, true))
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit).WithMetadata(new RequestSizeLimitAttribute(64 * 1024));
        facilitator.MapGet("/publication-moderation", (HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) => ReadAsync(context, database, access, token, true));
        facilitator.MapPost("/{projectId:guid}/publication-moderation", (Guid projectId, ModerationRequest request, HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) => ChangeAsync(projectId, request, context, database, access, token, true))
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute(4 * 1024));
        return endpoints;
    }

    private static async Task<IResult> ReadAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken token, bool educator)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        var query = context.Request.Query;
        if (query.Count != 1 || !query.TryGetValue("ids", out var values) || values.Count != 1
            || values[0] is not { Length: > 0 and <= 3699 } text)
        {
            return Invalid(context);
        }
        var parts = text.Split(',');
        var ids = new HashSet<Guid>();
        if (parts.Length is < 1 or > 100 || parts.Any(part =>
            !Guid.TryParseExact(part, "D", out var id) || id == Guid.Empty || !ids.Add(id)))
        {
            return Invalid(context);
        }
        if (await RecheckModeratorAsync(context, database, access, ids, educator, token, true) is { } denied) { return denied; }

        // Keep zero-edition projects in the bounded aggregate while excluding permanent retirement
        var retired = database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids");
        var current = database.Publications.AsNoTracking().Where(edition => !retired.Contains(edition.Id)
            && !database.PublicationAccess.Any(state => state.PublicationId == edition.Id && state.Deleted));
        var items = await (from project in database.Projects.AsNoTracking()
                           where ids.Contains(project.Id)
                           join edition in current on project.Id equals edition.ProjectId into editions
                           from edition in editions.DefaultIfEmpty()
                           join policy in database.PublicationAccess on edition.Id equals policy.PublicationId into policies
                           from policy in policies.DefaultIfEmpty()
                           group new { Edition = edition, Policy = policy, project.IsArchived } by project.Id into rows
                           orderby rows.Key
                           select new
                           {
                               projectId = rows.Key,
                               publicationCount = rows.Count(row => row.Edition != null),
                               hiddenCount = rows.Count(row => row.Policy != null && row.Policy.Hidden),
                               publicCount = rows.Count(row => !row.IsArchived && row.Policy != null
                                   && !row.Policy.Hidden && !row.Policy.Revoked
                                   && (row.Policy.Audience == (int)PublicationAudience.Public
                                       || row.Policy.Audience == (int)PublicationAudience.Unlisted))
                           }).ToArrayAsync(token);
        if (items.Length != ids.Count) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }

        // A role or session change during the read must not return administrator metadata
        if (await RecheckModeratorAsync(context, database, access, ids, educator, token, true) is { } changed) { return changed; }
        if (educator)
        {
            var drafts = await database.ClassAssignmentStudents.AsNoTracking().Where(row => ids.Contains(row.ProjectId))
                .Select(row => new
                {
                    row.ProjectId,
                    removed = !row.IsActive,
                    publishingBlocked = !database.ProjectAssignments.Any(grant => grant.ProjectId == row.ProjectId
                        && grant.UserId == row.StudentId && grant.CanPublish)
                }).ToDictionaryAsync(row => row.ProjectId, token);
            return Results.Ok(new
            {
                items = items.Select(row => new
                {
                    row.projectId,
                    row.publicationCount,
                    row.hiddenCount,
                    row.publicCount,
                    drafts[row.projectId].publishingBlocked,
                    drafts[row.projectId].removed
                })
            });
        }
        return Results.Ok(new { items });
    }

    private static async Task<IResult> ChangeManyAsync(SelectionRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken token, bool educator)
    {
        if (request.ProjectIds is not { Length: > 0 and <= 1000 } || request.ProjectIds.Contains(Guid.Empty)
            || request.Action is not ("hide" or "show" or "delete")) { return Invalid(context); }
        var ids = request.ProjectIds.Distinct().ToArray();
        if (await RecheckModeratorAsync(context, database, access, ids, educator, token, request.Action == "delete") is { } denied) { return denied; }
        foreach (var id in ids)
        {
            var result = await ChangeAsync(id, new(request.Action), context, database, access, token, educator);
            if (result is not IStatusCodeHttpResult { StatusCode: 204 }) { return result; }
        }
        return Results.NoContent();
    }

    private static async Task<IResult> ChangeAsync(Guid projectId, ModerationRequest request,
        HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token, bool educator)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        if (request.Action is not ("hide" or "show" or "delete")) { return Invalid(context); }

        // Share the project lock with publishing, archive and grant changes; archived drafts remain moderatable
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, token);
        if (await RecheckModeratorAsync(context, database, access, [projectId], educator, token, request.Action == "delete") is { } denied) { return denied; }
        var locked = await access.LockAsync(context, projectId, ProjectLockPurpose.ModeratePublications, token);
        if (locked.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        if (await RecheckModeratorAsync(context, database, access, [projectId], educator, token, request.Action == "delete") is { } changed) { return changed; }

        var editionIds = await database.Publications.Where(edition => edition.ProjectId == projectId)
            .Select(edition => edition.Id).ToArrayAsync(token);
        if (editionIds.Length == 0 && !educator) { return Unavailable(context); }
        var states = await database.PublicationAccess.Where(state => editionIds.Contains(state.PublicationId))
            .ToDictionaryAsync(state => state.PublicationId, token);
        var retired = await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids")
            .Where(id => editionIds.Contains(id)).ToArrayAsync(token);
        var targets = request.Action == "delete" ? editionIds : editionIds.Where(id => !retired.Contains(id)
            && (!states.TryGetValue(id, out var state) || !state.Deleted)).ToArray();
        if (targets.Length == 0 && !educator) { return Unavailable(context); }
        if (educator)
        {
            // Use the existing persistent grant so unpublished drafts are blocked without losing editing access
            var student = await database.ClassAssignmentStudents.SingleAsync(row => row.ProjectId == projectId, token);
            var grant = await database.ProjectAssignments.SingleOrDefaultAsync(row => row.ProjectId == projectId
                && row.UserId == student.StudentId, token);
            if (grant is null) { return Unavailable(context); }
            grant.CanPublish = request.Action == "show";
            if (request.Action == "delete") { student.IsActive = false; }
        }
        if (educator && request.Action != "show")
        {
            var submission = await database.ReviewSubmissions.Where(row => row.ProjectId == projectId)
                .OrderByDescending(row => row.Sequence).Select(row => row.Id).FirstOrDefaultAsync(token);
            var approval = await database.ReviewDecisions.Where(row => row.SubmissionId == submission)
                .OrderByDescending(row => row.Sequence).FirstOrDefaultAsync(token);
            if (approval?.Outcome == ReviewDecision.Approved)
            {
                if (approval.Sequence == long.MaxValue)
                { return ApiProblems.Create(context, 409, "review_decision_conflict", "The approval could not be withdrawn."); }
                database.ReviewDecisions.Add(new ReviewDecision
                {
                    Id = Guid.NewGuid(),
                    SubmissionId = submission,
                    EducatorId = locked.Snapshot!.ActorId,
                    Sequence = approval.Sequence + 1,
                    Outcome = ReviewDecision.Revoked,
                    Feedback = "Publication " + (request.Action == "hide" ? "hidden" : "deleted")
                        + " by the facilitator. Submit your work for a fresh approval before publishing again.",
                    RequestDigest = SHA256.HashData(Encoding.UTF8.GetBytes($"publication-moderation\n{projectId:D}\n{submission:D}\n{locked.Snapshot.ActorId:D}\n{request.Action}\n{approval.Sequence}")),
                });
            }
        }
        foreach (var id in targets)
        {
            if (!states.TryGetValue(id, out var state))
            {
                // Hiding or showing a legacy edition cannot invent a configured audience
                state = new PublicationAccessState { PublicationId = id, Audience = 0 };
                database.PublicationAccess.Add(state);
            }
            if (request.Action == "hide") { state.Hidden = true; }
            if (request.Action == "show") { state.Hidden = false; }
            if (request.Action == "delete") { state.Deleted = true; }
        }
        if (request.Action == "delete")
        {
            // Include legacy deleted editions too so restoring old policy data can never revive their links
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO retired_publication_ids (id)
                SELECT id FROM publications WHERE project_id = {projectId}
                ON CONFLICT DO NOTHING
                """, token);
        }
        await database.SaveChangesAsync(token);

        // Retain the lock through the final live-role check and commit, then reject expired acknowledgements
        if (await RecheckModeratorAsync(context, database, access, [projectId], educator, token, request.Action == "delete") is { } revoked) { return revoked; }
        await transaction.CommitAsync(token);
        token.ThrowIfCancellationRequested();
        return HasExpired(context)
            ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired)
            : Results.NoContent();
    }

    private static async Task<IResult?> RecheckModeratorAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, IReadOnlyCollection<Guid> projectIds, bool educator, CancellationToken token, bool allowRemoved = false)
    {
        var account = await access.ResolveCurrentAccountAsync(context, token);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        if (account.Role != (educator ? ApplicationRoles.Educator : ApplicationRoles.Administrator))
        { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden); }
        if (educator && await access.VisibleProjects(account).Where(project => projectIds.Contains(project.Id)
            && database.ClassAssignmentStudents.Any(student => student.ProjectId == project.Id && (allowRemoved || student.IsActive)))
            .CountAsync(token) != projectIds.Count)
        { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }
        return null;
    }

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
    private static IResult Invalid(HttpContext context) =>
        ApiProblems.Create(context, 400, "invalid_publication_moderation", "Check the project identifiers and publication action");
    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "publication_unavailable", "Publication is unavailable or access is not permitted");
}
