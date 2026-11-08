using Microsoft.EntityFrameworkCore;
using System.Data;
using System.Text.Json;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Deliver existing immutable editions through one current audience decision for JSON and bytes
internal static class PublicationDeliveryEndpoints
{
    internal static void MapPublicationDelivery(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/projects/{projectId:guid}/publication-links", (Guid projectId,
            HttpContext context, ApplicationDbContext database, ProjectAccessService access,
            IConfiguration configuration, CancellationToken token) => ReadLinksAsync(projectId, context, database, access, configuration, token))
            .RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapGet("/projects/publication-links", (HttpContext context, ApplicationDbContext database, ProjectAccessService access,
            IConfiguration configuration, CancellationToken token) => ReadLinksAsync(null, context, database, access, configuration, token))
            .RequireAuthorization(SecurityPolicies.FullAccount);

        endpoints.MapGet("/publications/{publicationId}/manifest", async (string publicationId,
            HttpContext context, ApplicationDbContext database, CancellationToken token) =>
        {
            var id = Guid.Parse(publicationId);
            var edition = await database.Publications.AsNoTracking().SingleAsync(row => row.Id == id, token);
            var references = JsonSerializer.Deserialize<PublicationAssetReference[]>(edition.AssetReferencesJson)
                ?? throw new InvalidOperationException("The publication manifest is invalid.");
            var ids = references.Select(reference => Guid.Parse(reference.AssetId)).ToArray();
            var assets = await database.AssetCandidates.AsNoTracking()
                .Where(asset => ids.Contains(asset.Id) && asset.Status == "approved" && !asset.RemovedFromProjects)
                .Select(asset => new { asset.Id, asset.Kind, asset.Sha256 }).ToListAsync(token);
            if (assets.Count != references.Length || references.Any(reference =>
                !assets.Any(asset => asset.Id == Guid.Parse(reference.AssetId) && asset.Sha256 == reference.Sha256)))
            { return Unavailable(context); }
            return Results.Ok(new
            {
                publicationId = id,
                edition.ProjectId,
                edition.SourceRevision,
                assets = assets.Select(asset => new
                {
                    id = asset.Id.ToString("D"),
                    kind = asset.Kind,
                    sha256 = asset.Sha256,
                    url = $"{ApiV1Endpoints.Prefix}/publications/{id:D}/assets/{asset.Id:D}/bytes",
                }),
            });
        }).RequirePublicationRead(PublicationReadKind.Snapshot);

        // Let the shared filter explain malformed IDs before reading the captured edition
        endpoints.MapMethods("/publications/{publicationId}", [HttpMethods.Get, HttpMethods.Head], async (string publicationId,
            ApplicationDbContext database, CancellationToken token) =>
        {
            var id = Guid.Parse(publicationId);
            var edition = await database.Publications.AsNoTracking().SingleAsync(row => row.Id == id, token);
            return Results.Content(edition.DocumentJson, "application/json");
        }).RequirePublicationRead(PublicationReadKind.Snapshot);

        endpoints.MapMethods("/publications/{publicationId}/assets/{assetId}/bytes", [HttpMethods.Get, HttpMethods.Head], async (string assetId,
            HttpContext context, ApplicationDbContext database, CancellationToken token) =>
        {
            // Recheck removal at byte loading too; never let a stale policy lookup bypass global removal
            var id = Guid.Parse(assetId);
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id
                && row.Status == "approved" && !row.RemovedFromProjects, token);
            return asset is null ? ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable")
                : Results.Bytes(asset.Bytes, AssetIntakePolicy.MediaType(asset.Kind));
        }).RequirePublicationRead(PublicationReadKind.Asset).RequireRateLimiting("AssetBytes");

        // Management metadata explains the current audience without granting visitor or draft access
        endpoints.MapGet("/publications/{publicationId:guid}/access", async (Guid publicationId,
            HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) =>
        {
            var edition = await database.Publications.AsNoTracking().SingleOrDefaultAsync(row => row.Id == publicationId, token);
            if (edition is null) { return Unavailable(context); }
            var grant = (await access.ReadAsync(context, edition.ProjectId, token)).Snapshot;
            if (grant is null || (!grant.CanManage
                && !(grant.ActorId == edition.PublishedById && grant.CanEdit && grant.CanPublish)))
            { return Unavailable(context); }
            var state = await database.PublicationAccess.AsNoTracking().SingleOrDefaultAsync(row => row.PublicationId == publicationId, token);
            var audience = state is null ? (PublicationAudience)0 : (PublicationAudience)state.Audience;
            context.Response.Headers.CacheControl = "private, no-store";
            return Results.Ok(new
            {
                publicationId,
                edition.ProjectId,
                audience = Enum.IsDefined(audience) ? audience.ToString() : "Unavailable",
                explanation = audience switch
                {
                    PublicationAudience.Public => "Anyone can open this publication without signing in",
                    PublicationAudience.Unlisted => "Anyone with the link can open this publication without signing in",
                    PublicationAudience.Authenticated => "Only permitted accounts can open this publication after signing in",
                    _ => "Access has not been configured; this publication is unavailable",
                },
                viewerIds = state?.ViewerIds ?? [],
                hidden = state?.Hidden ?? false,
                revoked = state?.Revoked ?? false,
                deleted = state?.Deleted ?? false,
                archived = grant.IsArchived,
                canManage = grant.CanManage,
            });
        }).RequireAuthorization(SecurityPolicies.FullAccount);

        endpoints.MapPost("/publications/{publicationId:guid}/access", async (Guid publicationId,
            PublicationAccessRequest request, HttpContext context, ApplicationDbContext database,
            ProjectAccessService access, CancellationToken token) =>
        {
            // Bound the complete policy request before looking up an edition or evaluating project authority
            if (!Enum.TryParse<PublicationAudience>(request.Audience, out var audience) || !Enum.IsDefined(audience)
                || request.ViewerIds is null || request.ViewerIds.Length > 100
                || request.ViewerIds.Any(id => id == Guid.Empty) || request.Action is not ("audience" or "hide" or "show" or "revoke" or "delete"))
            {
                return ApiProblems.Create(context, 400, "invalid_publication_access", "Check the audience and publication action");
            }

            // Only current managers and the still-authorised original publisher may change the audience
            var edition = await database.Publications.AsNoTracking().SingleOrDefaultAsync(row => row.Id == publicationId, token);
            if (edition is null) { return Unavailable(context); }
            var grant = (await access.ReadAsync(context, edition.ProjectId, token)).Snapshot;
            var publisher = grant is { CanEdit: true, CanPublish: true } && grant.ActorId == edition.PublishedById;
            if (grant is null || (!grant.CanManage && (!publisher || request.Action != "audience"))) { return Unavailable(context); }

            var ids = request.ViewerIds.Distinct().ToArray();

            // Serialize policy changes under the same project lock used by archive and permission changes
            await using var transaction = await database.Database.BeginTransactionAsync(token);
            var locked = await access.LockAsync(context, edition.ProjectId, grant.CanManage ? ProjectLockPurpose.ChangeArchiveState : ProjectLockPurpose.EditDraft, token);
            if (locked.Snapshot is not { } current || (!current.CanManage
                && !(request.Action == "audience" && current.ActorId == edition.PublishedById && current.CanEdit && current.CanPublish)))
            { return Unavailable(context); }

            // Anonymous audiences have no named viewers; changing access still requires current authority
            if (request.Action == "audience" && audience != PublicationAudience.Authenticated && ids.Length != 0)
            {
                return ApiProblems.Create(context, 400, "invalid_publication_audience", "Public and unlisted access cannot include named viewers");
            }

            // Validate newly chosen viewers against the locked project's current organization
            // Existing inactive viewers must never prevent managers from hiding or revoking an edition
            if (request.Action == "audience")
            {
                var eligible = await database.OrganizationMemberships.Where(member => member.OrganizationId == current.OrganizationId
                    && ids.Contains(member.UserId)
                    && database.Organizations.Any(org => org.Id == member.OrganizationId && org.IsActive)
                    && database.Users.Any(user => user.Id == member.UserId && user.IsActive && !user.MustChangePassword)
                    && database.UserRoles.Any(role => role.UserId == member.UserId && role.RoleId == member.RoleId))
                    .Select(member => member.UserId).ToArrayAsync(token);
                if (eligible.Length != ids.Length)
                {
                    return ApiProblems.Create(context, 400, "invalid_publication_audience", "Choose active accounts in this organization");
                }
            }

            // Missing policy starts restricted; permanent deletion cannot be cleared by another action
            var state = await database.PublicationAccess.SingleOrDefaultAsync(row => row.PublicationId == publicationId, token);
            if (state?.Deleted == true) { return Unavailable(context); }
            if (state is null)
            {
                state = new PublicationAccessState { PublicationId = publicationId };
                database.PublicationAccess.Add(state);
            }

            // Change only the requested restriction so Show cannot undo revocation or deletion
            if (request.Action == "audience") { state.Audience = (int)audience; state.ViewerIds = ids; }
            if (request.Action == "hide") { state.Hidden = true; }
            if (request.Action == "show") { state.Hidden = false; }
            if (request.Action == "revoke") { state.Revoked = true; }
            if (request.Action == "delete")
            {
                state.Deleted = true;

                // Preserve permanent denial independently of the retained edition and its access row
                await database.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO retired_publication_ids (id) VALUES ({publicationId}) ON CONFLICT DO NOTHING", token);
            }

            // Acknowledge only after the policy and retained project lock commit together
            await database.SaveChangesAsync(token);
            if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
            await transaction.CommitAsync(token);
            token.ThrowIfCancellationRequested();
            if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
            return Results.NoContent();
        }).RequireAuthorization(SecurityPolicies.FullAccount).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024));
    }

    private static async Task<IResult> ReadLinksAsync(Guid? projectId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, IConfiguration configuration, CancellationToken token)
    {
        var limit = 1;
        Guid? cursor = null;
        if (projectId is null && !ClassroomEndpoints.TryPage(context, out limit, out cursor))
        { return ApiProblems.Create(context, 400, "invalid_query", "Check the page size and cursor"); }

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, token);
        var account = await access.ResolveCurrentAccountAsync(context, token);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        if (projectId is null && account.Role != ApplicationRoles.Creator)
        { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden); }
        var projects = access.VisibleProjects(account);
        if (projectId is { } id)
        {
            projects = projects.Where(project => project.Id == id);
            if (!await projects.AnyAsync(token)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }
        }
        if (!PublicationWriteEndpoints.TryOrigin(configuration, out var origin))
        { return ApiProblems.Create(context, 503, "publication_unavailable", "Publication is not configured."); }
        if (cursor is { } after) { projects = projects.Where(project => project.Id.CompareTo(after) > 0); }
        var dashboard = account.Role == ApplicationRoles.Creator && (projectId is null || context.Request.Query["view"] == "dashboard");
        var editions = from edition in database.Publications
                       join state in database.PublicationAccess on edition.Id equals state.PublicationId
                       where !state.Hidden && !state.Revoked && !state.Deleted
                       where state.Audience == (int)PublicationAudience.Unlisted
                           || (dashboard && state.Audience == (int)PublicationAudience.Public)
                           || (dashboard && state.Audience == (int)PublicationAudience.Authenticated
                               && (state.ViewerIds.Contains(account.UserId) || (edition.PublishedById == account.UserId
                                   && database.ProjectAssignments.Any(grant => grant.ProjectId == edition.ProjectId
                                       && grant.UserId == account.UserId && grant.CanPublish))))
                       select new { edition.ProjectId, edition.Id, edition.SourceRevision, edition.CreatedAt, state.Audience };
        var latestLinks = from project in projects
                          where !project.IsArchived
                          from link in editions.Where(row => row.ProjectId == project.Id)
                              .OrderByDescending(row => row.CreatedAt).ThenByDescending(row => row.Id).Take(1)
                          orderby project.Id
                          select link;
        var rows = await latestLinks.Take(limit + 1).ToArrayAsync(token);
        var items = rows.Take(limit).Select(row => new
        {
            row.ProjectId,
            publicationId = row.Id,
            row.SourceRevision,
            row.CreatedAt,
            requiresSignIn = row.Audience == (int)PublicationAudience.Authenticated,
            visitorUrl = new Uri(origin!, $"p/{row.Id:D}").AbsoluteUri
        });
        await transaction.CommitAsync(token);
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        context.Response.Headers.CacheControl = "private, no-store";
        return projectId.HasValue ? Results.Ok(new { items }) : Results.Ok(new
        {
            items,
            nextCursor = rows.Length > limit ? rows[limit - 1].ProjectId : (Guid?)null
        });
    }

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "publication_unavailable", "Publication is unavailable or access is not permitted");
}
