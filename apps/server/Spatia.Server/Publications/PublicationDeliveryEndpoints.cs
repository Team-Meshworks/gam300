using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Deliver existing immutable editions through one current audience decision for JSON and bytes
internal static class PublicationDeliveryEndpoints
{
    internal static void MapPublicationDelivery(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/projects/{projectId:guid}/publication-links", async (Guid projectId,
            HttpContext context, ApplicationDbContext database, ProjectAccessService access,
            IConfiguration configuration, CancellationToken token) =>
        {
            var authorized = await access.ReadAsync(context, projectId, token);
            if (authorized.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
            if (!PublicationWriteEndpoints.TryOrigin(configuration, out var origin))
            { return ApiProblems.Create(context, 503, "publication_unavailable", "Publication is not configured."); }
            var rows = authorized.Snapshot!.IsArchived ? [] : await (from edition in database.Publications.AsNoTracking()
                                                                     join state in database.PublicationAccess.AsNoTracking() on edition.Id equals state.PublicationId
                                                                     where edition.ProjectId == projectId && state.Audience == (int)PublicationAudience.Unlisted
                                                                         && !state.Hidden && !state.Revoked && !state.Deleted
                                                                     orderby edition.CreatedAt descending, edition.Id descending
                                                                     select new { edition.Id, edition.SourceRevision, edition.CreatedAt }).Take(1).ToArrayAsync(token);
            var rechecked = await access.ReadAsync(context, projectId, token);
            if (rechecked.Failure is { } changed) { return ProjectHttpResults.FromAccessFailure(context, changed); }
            if (rechecked.Snapshot!.IsArchived) { rows = []; }
            context.Response.Headers.CacheControl = "private, no-store";
            return Results.Ok(new
            {
                items = rows.Select(row => new
                {
                    publicationId = row.Id,
                    row.SourceRevision,
                    row.CreatedAt,
                    visitorUrl = new Uri(origin!, $"p/{row.Id:D}").AbsoluteUri
                })
            });
        }).RequireAuthorization(SecurityPolicies.FullAccount);

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
                : Results.Bytes(asset.Bytes, "model/gltf-binary");
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

            // Match the publisher's unavailable result until public/unlisted lifecycle policy is agreed
            // Existing stored editions retain their read policy; this cannot promote a restricted edition
            if (request.Action == "audience" && audience is PublicationAudience.Public or PublicationAudience.Unlisted)
            {
                return ApiProblems.Create(context, 503, "publication_unavailable", "This audience is not available for new access changes.");
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
            if (request.Action == "delete") { state.Deleted = true; }

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

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "publication_unavailable", "Publication is unavailable or access is not permitted");
}
