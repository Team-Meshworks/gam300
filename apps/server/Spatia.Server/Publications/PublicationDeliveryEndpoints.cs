using Microsoft.EntityFrameworkCore;
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
        // Read the captured edition only after the shared filter permits its current audience and lifecycle
        endpoints.MapGet("/api/publications/{publicationId:guid}", async (Guid publicationId,
            ApplicationDbContext database, CancellationToken token) =>
        {
            var edition = await database.Publications.AsNoTracking().SingleAsync(row => row.Id == publicationId, token);
            return Results.Content(edition.DocumentJson, "application/json");
        }).RequirePublicationRead(PublicationReadKind.Snapshot);

        endpoints.MapGet("/api/publications/{publicationId:guid}/assets/{assetId}/bytes", async (string assetId,
            HttpContext context, ApplicationDbContext database, CancellationToken token) =>
        {
            // Recheck removal at byte loading too; never let a stale policy lookup bypass global removal
            var id = Guid.Parse(assetId);
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id
                && row.Status == "approved" && !row.RemovedFromProjects, token);
            return asset is null ? ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable")
                : Results.Bytes(asset.Bytes, "model/gltf-binary");
        }).RequirePublicationRead(PublicationReadKind.Asset).RequireRateLimiting("AssetBytes");

        endpoints.MapPost("/api/publications/{publicationId:guid}/access", async (Guid publicationId,
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

            // Validate named accounts in the publication's organization; visitor grants never create draft access
            var ids = request.ViewerIds.Distinct().ToArray();
            var eligible = await database.OrganizationMemberships.Where(row => row.OrganizationId == grant.OrganizationId
                && ids.Contains(row.UserId)).Select(row => row.UserId).ToArrayAsync(token);
            if (eligible.Length != ids.Length) { return ApiProblems.Create(context, 400, "invalid_publication_audience", "Choose accounts in this organization"); }

            // Serialize policy changes under the same project lock used by archive and permission changes
            await using var transaction = await database.Database.BeginTransactionAsync(token);
            var locked = await access.LockAsync(context, edition.ProjectId, grant.CanManage ? ProjectLockPurpose.ChangeArchiveState : ProjectLockPurpose.EditDraft, token);
            if (locked.Snapshot is not { } current || (!current.CanManage
                && !(request.Action == "audience" && current.ActorId == edition.PublishedById && current.CanEdit && current.CanPublish)))
            { return Unavailable(context); }

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
            await transaction.CommitAsync(token);
            return Results.NoContent();
        }).RequireAuthorization(SecurityPolicies.FullAccount).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024));
    }

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "publication_unavailable", "Publication is unavailable or access is not permitted");
}
