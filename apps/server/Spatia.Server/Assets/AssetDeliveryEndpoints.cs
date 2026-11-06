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
        endpoints.MapGet("/assets", async (HttpContext context, ApplicationDbContext database, CancellationToken token) =>
        {
            var prefix = ApiV1Endpoints.PrefixFor(context);
            return Results.Ok(await database.AssetCandidates.AsNoTracking()
                .Where(asset => asset.Status == "approved" && !asset.Hidden && !asset.Deleted && !asset.RemovedFromProjects)
                .Select(asset => new
                {
                    id = asset.Id.ToString(),
                    asset.Name,
                    asset.Kind,
                    asset.Category,
                    url = prefix + "/assets/" + asset.Id + "/bytes",
                    asset.Sha256,
                    thumbnail = (string?)null
                })
                .Take(1000).ToArrayAsync(token));
        }).RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapGet("/projects/{projectId:guid}/assets", async (Guid projectId, HttpContext context,
            ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents, CancellationToken token) =>
        {
            var authorization = await access.ReadAsync(context, projectId, token);
            if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
            var project = authorization.Snapshot!;
            if (!documents.ReadStored(projectId, project.SchemaVersion, project.UnvalidatedDocumentJson).Ok)
            { return ApiProblems.Create(context, 503, "project_unavailable", "Project assets are unavailable"); }
            // Resolve every saved reference, independent of discovery pagination and retirement.
            // Project-scoped delivery retains its existing access and removal checks on every byte read.
            var ids = AssetDocumentReferences.Read(project.UnvalidatedDocumentJson)
                .Where(value => Guid.TryParse(value, out _)).Select(Guid.Parse).ToArray();
            var prefix = ApiV1Endpoints.PrefixFor(context);
            var rows = await database.AssetCandidates.AsNoTracking()
                .Where(asset => ids.Contains(asset.Id) && asset.Status == "approved" && !asset.RemovedFromProjects)
                .Select(asset => new
                {
                    id = asset.Id.ToString(),
                    asset.Name,
                    asset.Kind,
                    asset.Category,
                    url = prefix + "/projects/" + projectId + "/assets/" + asset.Id + "/bytes",
                    asset.Sha256,
                    thumbnail = (string?)null
                }).ToArrayAsync(token);
            if (context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc)
            { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
            context.Response.Headers.CacheControl = "private, no-store";
            return Results.Ok(rows);
        }).RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapGet("/assets/{id:guid}/bytes", async (Guid id, HttpContext context,
            ApplicationDbContext database, CancellationToken token) =>
        {
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(asset => asset.Id == id
                && asset.Status == "approved" && !asset.Hidden && !asset.Deleted && !asset.RemovedFromProjects, token);
            return Bytes(context, asset);
        }).RequireAuthorization(SecurityPolicies.FullAccount).RequireRateLimiting("AssetBytes");
        endpoints.MapGet("/projects/{projectId:guid}/assets/{id:guid}/bytes", async (Guid projectId, Guid id,
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
