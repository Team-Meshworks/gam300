using System.Text.Json;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Publications;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>Read-only inspection of immutable published exhibitions by current project moderators</summary>
public static class ProjectExhibitionEndpoints
{
    public static IEndpointRouteBuilder MapProjectExhibitions(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/projects/{projectId:guid}").RequireAuthorization(SecurityPolicies.FullAccount);
        group.MapGet("/exhibition", ReadAsync);
        group.MapGet("/exhibitions/{publicationId:guid}/assets/{assetId}/bytes", BytesAsync).RequireRateLimiting("AssetBytes");
        return endpoints;
    }

    private static async Task<IResult?> AuthorizeAsync(Guid projectId, HttpContext context,
        ProjectAccessService access, CancellationToken token)
    {
        context.Response.Headers.CacheControl = "private, no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        var result = await access.ReadAsync(context, projectId, token);
        if (result.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var account = await access.ResolveCurrentAccountAsync(context, token);
        return account?.Role is ApplicationRoles.Administrator or ApplicationRoles.Educator
            ? null : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
    }

    private static IQueryable<Publication> Editions(ApplicationDbContext database, Guid projectId)
    {
        var retired = database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids");
        return database.Publications.AsNoTracking().Where(edition => edition.ProjectId == projectId
            && !retired.Contains(edition.Id)
            && !database.PublicationAccess.Any(state => state.PublicationId == edition.Id && state.Deleted));
    }

    private static async Task<IResult> ReadAsync(Guid projectId, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents,
        IHostEnvironment environment, CancellationToken token)
    {
        if (await AuthorizeAsync(projectId, context, access, token) is { } denied) { return denied; }
        var edition = await Editions(database, projectId).OrderByDescending(row => row.CreatedAt)
            .ThenByDescending(row => row.Id).FirstOrDefaultAsync(token);
        if (edition is null) { return Unavailable(context); }
        var document = documents.ReadStored(projectId, edition.SchemaVersion, edition.DocumentJson);
        if (!document.Ok) { return Unavailable(context); }
        var references = JsonSerializer.Deserialize<PublicationAssetReference[]>(edition.AssetReferencesJson) ?? [];
        var assetIds = references.Where(row => Guid.TryParseExact(row.AssetId, "D", out _)).Select(row => Guid.Parse(row.AssetId)).ToArray();
        var retained = await database.AssetCandidates.AsNoTracking()
            .Where(row => assetIds.Contains(row.Id) && row.Status == "approved" && !row.RemovedFromProjects)
            .Select(row => new { row.Id, row.Name, row.Kind, row.Category, row.Sha256 }).ToDictionaryAsync(row => row.Id, token);
        var assets = new List<object>();
        foreach (var reference in references)
        {
            string name;
            string kind;
            string? category = null;
            string? placement = null;
            if (Guid.TryParseExact(reference.AssetId, "D", out var id))
            {
                if (!retained.TryGetValue(id, out var asset) || asset.Sha256 != reference.Sha256) { return Unavailable(context); }
                name = asset.Name;
                kind = asset.Kind;
                category = asset.Category;
            }
            else
            {
                if (!environment.IsDevelopment()) { return Unavailable(context); }
                var rows = await database.Database.SqlQuery<DevelopmentMetadata>($"""
                    SELECT kind AS "Kind", placement AS "Placement" FROM development_publication_assets
                    WHERE publication_id = {edition.Id} AND asset_id = {reference.AssetId} AND sha256 = {reference.Sha256}
                    """).ToArrayAsync(token);
                if (rows.Length != 1) { return Unavailable(context); }
                name = reference.AssetId;
                kind = rows[0].Kind;
                placement = rows[0].Placement;
            }
            assets.Add(new { id = reference.AssetId, name, kind, category, placement, sha256 = reference.Sha256,
                url = $"{ApiV1Endpoints.Prefix}/projects/{projectId:D}/exhibitions/{edition.Id:D}/assets/{Uri.EscapeDataString(reference.AssetId)}/bytes" });
        }
        if (await AuthorizeAsync(projectId, context, access, token) is { } changed) { return changed; }
        using var json = JsonDocument.Parse(edition.DocumentJson);
        return Results.Ok(new { projectId, publicationId = edition.Id, revision = edition.SourceRevision,
            document = json.RootElement.Clone(), assets });
    }

    private static async Task<IResult> BytesAsync(Guid projectId, Guid publicationId, string assetId,
        HttpContext context, ApplicationDbContext database, ProjectAccessService access,
        IHostEnvironment environment, CancellationToken token)
    {
        if (await AuthorizeAsync(projectId, context, access, token) is { } denied) { return denied; }
        var edition = await Editions(database, projectId).SingleOrDefaultAsync(row => row.Id == publicationId, token);
        if (edition is null) { return Unavailable(context); }
        var reference = (JsonSerializer.Deserialize<PublicationAssetReference[]>(edition.AssetReferencesJson) ?? [])
            .SingleOrDefault(row => row.AssetId == assetId);
        if (reference is null) { return Unavailable(context); }
        if (Guid.TryParseExact(assetId, "D", out var id))
        {
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id
                && row.Status == "approved" && !row.RemovedFromProjects && row.Sha256 == reference.Sha256, token);
            if (await AuthorizeAsync(projectId, context, access, token) is { } changed) { return changed; }
            return asset is null ? Unavailable(context) : Results.Bytes(asset.Bytes, AssetIntakePolicy.MediaType(asset.Kind));
        }
        if (!environment.IsDevelopment()) { return Unavailable(context); }
        var rows = await database.Database.SqlQuery<DevelopmentBytes>($"""
            SELECT a.sha256 AS "Sha256", a.media_type AS "MediaType", b.bytes AS "Bytes"
            FROM development_publication_assets a JOIN development_publication_blobs b ON b.sha256 = a.sha256
            WHERE a.publication_id = {publicationId} AND a.asset_id = {assetId} AND a.sha256 = {reference.Sha256}
            """).ToArrayAsync(token);
        if (await AuthorizeAsync(projectId, context, access, token) is { } current) { return current; }
        return rows.Length == 1 && Convert.ToHexStringLower(SHA256.HashData(rows[0].Bytes)) == reference.Sha256
            ? Results.Bytes(rows[0].Bytes, rows[0].MediaType) : Unavailable(context);
    }

    private static IResult Unavailable(HttpContext context) => ApiProblems.Create(context, 404,
        "exhibition_unavailable", "The published exhibition is unavailable.");
    private sealed record DevelopmentMetadata(string Kind, string? Placement);
    private sealed record DevelopmentBytes(string Sha256, string MediaType, byte[] Bytes);
}
