using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Assets;

/// <summary>Separates new catalogue selections from retained bytes authorized through a saved project</summary>
public static class AssetDeliveryEndpoints
{
    public static IEndpointRouteBuilder MapAssetDelivery(this IEndpointRouteBuilder endpoints)
    {
        // New selections see only active reviewed versions; retained project reads use a separate route below
        endpoints.MapGet("/api/assets", async (ApplicationDbContext database, CancellationToken token) =>
            Results.Ok(await database.AssetCandidates.AsNoTracking()
                .Where(asset => asset.Status == "approved" && !asset.Hidden && !asset.Deleted && !asset.RemovedFromProjects)
                .Select(asset => new
                {
                    id = asset.Id.ToString(),
                    asset.Name,
                    asset.Kind,
                    asset.Category,
                    url = "/api/assets/" + asset.Id + "/bytes",
                    asset.Sha256,
                    thumbnail = (string?)null
                })
                .Take(1000).ToArrayAsync(token))).RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapGet("/api/assets/{id:guid}/bytes", async (Guid id, HttpContext context,
            ApplicationDbContext database, CancellationToken token) =>
        {
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(asset => asset.Id == id
                && asset.Status == "approved" && !asset.Hidden && !asset.Deleted && !asset.RemovedFromProjects, token);
            return Bytes(context, asset);
        }).RequireAuthorization(SecurityPolicies.FullAccount).RequireRateLimiting("AssetBytes");
        endpoints.MapGet("/api/projects/{projectId:guid}/assets/{id:guid}/bytes", async (Guid projectId, Guid id,
            HttpContext context, ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents,
            CancellationToken token) =>
        {
            // Recheck current project authority on each byte request instead of exposing a static file URL
            var authorization = await access.ReadAsync(context, projectId, token);
            if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
            var project = authorization.Snapshot!;
            var valid = documents.ReadStored(projectId, project.SchemaVersion, project.UnvalidatedDocumentJson);
            if (!valid.Ok || !AssetDocumentReferences.Read(project.UnvalidatedDocumentJson).Contains(id.ToString()))
            {
                return ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable");
            }
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(asset => asset.Id == id
                && asset.Status == "approved" && !asset.RemovedFromProjects, token);
            return Bytes(context, asset);
        }).RequireAuthorization(SecurityPolicies.FullAccount).RequireRateLimiting("AssetBytes");
        return endpoints;
    }

    private static IResult Bytes(HttpContext context, AssetCandidate? asset)
    {
        if (asset is null) { return ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable"); }
        // Revalidate authority on the next request rather than allowing a shared cache to serve retained bytes
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        return Results.Bytes(asset.Bytes, "model/gltf-binary");
    }
}
