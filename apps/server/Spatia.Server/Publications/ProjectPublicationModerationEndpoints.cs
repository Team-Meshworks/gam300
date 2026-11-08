using System.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Moderate existing editions without rewriting the draft or immutable publication history
internal static class ProjectPublicationModerationEndpoints
{
    internal sealed record ModerationRequest(string Action);

    public static IEndpointRouteBuilder MapProjectPublicationModeration(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/admin/projects").RequireAuthorization(SecurityPolicies.Administrator);
        group.MapGet("/publication-moderation", ReadAsync);
        group.MapPost("/{projectId:guid}/publication-moderation", ChangeAsync)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute(4 * 1024));
        return endpoints;
    }

    private static async Task<IResult> ReadAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken token)
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
        if (await RecheckAdministratorAsync(context, access, token) is { } denied) { return denied; }

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
        if (await RecheckAdministratorAsync(context, access, token) is { } changed) { return changed; }
        return Results.Ok(new { items });
    }

    private static async Task<IResult> ChangeAsync(Guid projectId, ModerationRequest request,
        HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        if (request.Action is not ("hide" or "show" or "delete")) { return Invalid(context); }

        // Share the project lock with publishing, archive and grant changes; archived drafts remain moderatable
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, token);
        if (await RecheckAdministratorAsync(context, access, token) is { } denied) { return denied; }
        var locked = await access.LockAsync(context, projectId, ProjectLockPurpose.ChangeArchiveState, token);
        if (locked.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        if (await RecheckAdministratorAsync(context, access, token) is { } changed) { return changed; }

        var editionIds = await database.Publications.Where(edition => edition.ProjectId == projectId)
            .Select(edition => edition.Id).ToArrayAsync(token);
        if (editionIds.Length == 0) { return Unavailable(context); }
        var states = await database.PublicationAccess.Where(state => editionIds.Contains(state.PublicationId))
            .ToDictionaryAsync(state => state.PublicationId, token);
        var retired = await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids")
            .Where(id => editionIds.Contains(id)).ToArrayAsync(token);
        var targets = request.Action == "delete" ? editionIds : editionIds.Where(id => !retired.Contains(id)
            && (!states.TryGetValue(id, out var state) || !state.Deleted)).ToArray();
        if (targets.Length == 0) { return Unavailable(context); }
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
        if (await RecheckAdministratorAsync(context, access, token) is { } revoked) { return revoked; }
        await transaction.CommitAsync(token);
        token.ThrowIfCancellationRequested();
        return HasExpired(context)
            ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired)
            : Results.NoContent();
    }

    private static async Task<IResult?> RecheckAdministratorAsync(HttpContext context,
        ProjectAccessService access, CancellationToken token)
    {
        var account = await access.ResolveCurrentAccountAsync(context, token);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        return account.Role == ApplicationRoles.Administrator ? null
            : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
    }

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
    private static IResult Invalid(HttpContext context) =>
        ApiProblems.Create(context, 400, "invalid_publication_moderation", "Check the project identifiers and publication action");
    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "publication_unavailable", "Publication is unavailable or access is not permitted");
}
