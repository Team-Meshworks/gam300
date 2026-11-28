using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Assets;

/// <summary>Owns private intake and ordinary retirement without changing existing authored documents</summary>
public sealed class AssetAdministrationService(ApplicationDbContext database, AssetUploadValidator validator, IConfiguration configuration)
{
    private readonly int _maxRetainedAssets = AssetIntakePolicy.MaxRetainedAssets(configuration);
    private readonly long _maxRetainedBytes = AssetIntakePolicy.MaxRetainedBytes(configuration);

    // List and retry responses need administration metadata only, even for 20 MB assets.
    private IQueryable<AssetCandidate> CandidateMetadata => database.AssetCandidates.AsNoTracking()
        .Select(asset => new AssetCandidate
        {
            Id = asset.Id,
            Name = asset.Name,
            Kind = asset.Kind,
            Category = asset.Category,
            CatalogueName = asset.CatalogueName,
            CatalogueCategory = asset.CatalogueCategory,
            CatalogueSource = asset.CatalogueSource,
            CatalogueLicense = asset.CatalogueLicense,
            CatalogueReviewNotes = asset.CatalogueReviewNotes,
            Tags = asset.Tags,
            Sha256 = asset.Sha256,
            Bytes = Array.Empty<byte>(),
            Status = asset.Status,
            ValidationJson = asset.ValidationJson,
            CreatedAt = asset.CreatedAt,
            Hidden = asset.Hidden,
            Deleted = asset.Deleted,
            RemovedFromProjects = asset.RemovedFromProjects,
            Source = asset.Source,
            License = asset.License,
            ReviewNotes = asset.ReviewNotes,
        });

    public async Task<AssetAdministrationRecord[]> ListAsync(CancellationToken token) =>
        (await CandidateMetadata.OrderByDescending(asset => asset.CreatedAt).Take(AssetIntakePolicy.CatalogueLimit).ToArrayAsync(token)).Select(Record).ToArray();

    public async Task<string[]> ListTagsAsync(CancellationToken token) =>
        await database.CatalogueTags.AsNoTracking().OrderBy(tag => tag.Name).Select(tag => tag.Name).ToArrayAsync(token);

    // Unknown tags join the shared list; a matching key reuses the existing spelling instead.
    // Concurrent admins adding the same new tag both end up with the one stored row.
    internal async Task<string[]> ResolveTagsAsync(string[] tags, Guid actor, CancellationToken token)
    {
        if (tags.Length == 0)
            return [];
        var now = DateTimeOffset.UtcNow;
        foreach (var name in tags)
        {
            var key = AssetTags.Key(name);
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO asset_tags (key, name, created_by, created_at) VALUES ({key}, {name}, {actor}, {now}) ON CONFLICT (key) DO NOTHING", token);
        }
        var keys = tags.Select(AssetTags.Key).ToArray();
        var stored = await database.CatalogueTags.AsNoTracking().Where(tag => keys.Contains(tag.Key))
            .ToDictionaryAsync(tag => tag.Key, tag => tag.Name, token);
        return keys.Select(key => stored[key]).ToArray();
    }

    internal async Task<AssetAdministrationRecord> ReadRecordAsync(Guid id, CancellationToken token) =>
        Record(await CandidateMetadata.SingleAsync(asset => asset.Id == id, token));

    public async Task<(AssetAdministrationRecord? Record, bool Created, bool QuotaExceeded)?> SubmitAsync(string name, string kind, string? category,
        byte[] bytes, Guid actor, AssetReviewRequest? metadata, CancellationToken token, string? displayName = null, string[]? tags = null)
    {
        if (database.Database.CurrentTransaction is null)
            throw new InvalidOperationException("Asset uploads require a caller-owned transaction.");

        // Repeat input bounds here because the service can be called outside the HTTP upload handler
        var requestedTags = AssetTags.Read(tags);
        if (!AssetIntakePolicy.Accepts(name, kind, category) || (displayName is not null && !AssetIntakePolicy.ValidDisplayName(displayName))
            || bytes.Length is < 1 or > AssetIntakePolicy.MaxBytes || actor == Guid.Empty || requestedTags is null)
        {
            return null;
        }

        var label = displayName?.Trim() ?? name[..^4];
        var digest = Convert.ToHexStringLower(SHA256.HashData(bytes));
        // Validation stays outside the quota lock so other uploads can validate concurrently.
        var validation = kind == "audio" ? AssetAudioValidator.Validate(bytes) : await validator.ValidateAsync(bytes, token);
        await database.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(167168)", token);
        // Replaying the original upload must still resolve the same ID after a rename or recategorisation.
        var existing = await CandidateMetadata
            .Where(asset => asset.Sha256 == digest && asset.Name == label && asset.Kind == kind && asset.Category == category)
            .OrderBy(asset => asset.CreatedAt).ThenBy(asset => asset.Id)
            .FirstOrDefaultAsync(token);

        if (existing is not null)
            return (Record(existing), false, false);

        if (validation is null)
            return null;

        var count = await database.AssetCandidates.CountAsync(token);
        var total = await database.AssetCandidates.SumAsync(item => (long?)item.Bytes.Length, token) ?? 0;

        if (count >= _maxRetainedAssets || bytes.Length > _maxRetainedBytes - total)
            return (null, false, true);

        // New candidates alone consume quota and receive an immutable ID and the submitted provenance.
        var storedTags = await ResolveTagsAsync(requestedTags, actor, token);
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = label,
            Kind = kind,
            Category = category,
            Tags = storedTags,
            Sha256 = digest,
            Bytes = bytes,
            Status = validation.Value.Valid ? "approved" : "invalid",
            Hidden = !validation.Value.Valid,
            ReviewedBy = validation.Value.Valid ? actor : null,
            Source = validation.Value.Valid ? metadata?.Source ?? "" : null,
            License = validation.Value.Valid ? metadata?.License ?? "" : null,
            ReviewNotes = validation.Value.Valid ? string.IsNullOrEmpty(metadata?.ReviewNotes) ? "Made available automatically after technical validation." : metadata.ReviewNotes : null,
            ValidationJson = JsonSerializer.Serialize(validation.Value.Messages),
            SubmittedBy = actor,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        database.AssetCandidates.Add(asset);
        await database.SaveChangesAsync(token);
        return (Record(asset), true, false);
    }

    public async Task<AssetAdministrationRecord?> UpdateDetailsAsync(Guid id, AssetDetailsRequest details, Guid actor, CancellationToken token)
    {
        // Omitted tags leave the asset's tags unchanged for clients that predate tagging
        var requestedTags = details.Tags is null ? null : AssetTags.Read(details.Tags) ?? throw new ArgumentException("Invalid tags", nameof(details));
        if (!await database.AssetCandidates.AnyAsync(asset => asset.Id == id && !asset.Deleted && asset.Kind == details.Kind, token))
            return null;
        var tags = requestedTags is null ? null : await ResolveTagsAsync(requestedTags, actor, token);
        var changed = await database.AssetCandidates.Where(asset => asset.Id == id && !asset.Deleted && asset.Kind == details.Kind)
            .ExecuteUpdateAsync(update =>
            {
                update.SetProperty(asset => asset.CatalogueName, details.Name.Trim())
                    .SetProperty(asset => asset.CatalogueCategory, details.Category)
                    .SetProperty(asset => asset.CatalogueSource, details.Review.Source ?? "")
                    .SetProperty(asset => asset.CatalogueLicense, details.Review.License ?? "")
                    .SetProperty(asset => asset.CatalogueReviewNotes, details.Review.ReviewNotes ?? "");
                if (tags is not null)
                    update.SetProperty(asset => asset.Tags, tags);
            }, token);
        return changed == 1 ? await ReadRecordAsync(id, token) : null;
    }

    // Changing media type creates a new validated version. Saved projects can still use the original ID and bytes.
    public async Task<AssetAdministrationRecord?> ReplaceTypeAsync(Guid id, AssetAdministrationRecord replacement, CancellationToken token)
    {
        var original = await database.AssetCandidates
            .FromSqlInterpolated($"SELECT * FROM asset_candidates WHERE id = {id} FOR NO KEY UPDATE")
            .Select(asset => new { asset.Kind, asset.Hidden, asset.Deleted }).SingleOrDefaultAsync(token);
        if (original is null || original.Deleted || (original.Kind, replacement.Kind) is not (("audio", "model") or ("model", "audio")))
            return null;

        await ChangeAsync(id, "delete", token);
        return original.Hidden ? await ChangeAsync(replacement.Id, "hide", token) : replacement;
    }

    public async Task<AssetAdministrationRecord?> ReviewAsync(Guid id, AssetReviewRequest review, Guid actor, CancellationToken token)
    {
        // Record the explicit administrator decision; omitted details use empty strings for the stored approval contract
        var changed = await database.AssetCandidates.Where(asset => asset.Id == id && !asset.Deleted && asset.Status == "pending")
            .ExecuteUpdateAsync(update => update.SetProperty(asset => asset.Status, "approved")
                .SetProperty(asset => asset.Hidden, false).SetProperty(asset => asset.Source, review.Source ?? "")
                .SetProperty(asset => asset.License, review.License ?? "").SetProperty(asset => asset.ReviewNotes, review.ReviewNotes ?? "")
                .SetProperty(asset => asset.CatalogueSource, (string?)null).SetProperty(asset => asset.CatalogueLicense, (string?)null)
                .SetProperty(asset => asset.CatalogueReviewNotes, (string?)null)
                .SetProperty(asset => asset.ReviewedBy, actor), token);

        // Return the persisted record so the client replaces its state only after the database accepts review
        return changed == 1 ? await ReadRecordAsync(id, token) : null;
    }

    public async Task<AssetAdministrationRecord?> ChangeAsync(Guid id, string action, CancellationToken token)
    {
        // Ordinary retirement changes discoverability only and keeps exact bytes for existing references
        var query = database.AssetCandidates.Where(asset => asset.Id == id && !asset.Deleted);
        var changed = action == "delete"
            ? await query.ExecuteUpdateAsync(update => update.SetProperty(asset => asset.Deleted, true).SetProperty(asset => asset.Hidden, true), token)
            : await query.Where(asset => asset.Status == "approved")
                .ExecuteUpdateAsync(update => update.SetProperty(asset => asset.Hidden, action == "hide"), token);

        // A missing or concurrently retired row stays a conflict rather than a fabricated success
        return changed == 1 ? await ReadRecordAsync(id, token) : null;
    }

    // The caller owns the transaction and checks live administrator authority before committing
    public async Task<AssetAdministrationRecord?> RemoveAsync(Guid id,
        ProjectDocumentService documents, CancellationToken token)
    {
        // Block project creation, writes and row-locking publication/review operations during the global change
        await database.Database.ExecuteSqlRawAsync("LOCK TABLE projects IN EXCLUSIVE MODE", token);
        // Non-key updates must coexist with receipt foreign-key checks on this asset.
        var asset = await database.AssetCandidates.FromSqlInterpolated($"SELECT * FROM asset_candidates WHERE id = {id} FOR NO KEY UPDATE")
            .SingleOrDefaultAsync(token);

        if (asset is null || asset.Status != "approved" || asset.RemovedFromProjects || !asset.Deleted)
            return null;

        var assetId = id.ToString("D");
        var pattern = "%" + assetId + "%";
        // Page matching drafts while the table lock keeps the set stable without retaining every document in memory
        var cursor = Guid.Empty;

        while (true)
        {
            var projects = await database.Projects.FromSqlInterpolated($"""
                SELECT * FROM projects WHERE document::text LIKE {pattern} AND id > {cursor} ORDER BY id LIMIT 10
                """).ToArrayAsync(token);

            if (projects.Length == 0)
                break;

            foreach (var project in projects)
            {
                if (!AssetDocumentReferences.Read(project.DocumentJson).Contains(assetId))
                    continue;

                if (project.Revision == Project.MaxRevision || !documents.ReadStored(project.Id, project.SchemaVersion, project.DocumentJson).Ok)
                    return null;

                var removed = AssetDocumentRemoval.Remove(project.DocumentJson, assetId);
                using var parsed = JsonDocument.Parse(removed);
                var version = parsed.RootElement.GetProperty("schemaVersion").GetInt32();

                if (!documents.ReadStored(project.Id, version, removed).Ok)
                    return null;

                project.DocumentJson = removed;
                project.SchemaVersion = version;
                project.Revision++;
                project.UpdatedAt = DateTimeOffset.UtcNow;
                project.LastMutationActorId = null;
                project.LastMutationId = null;
                project.LastMutationDigest = null;
            }

            await database.SaveChangesAsync(token);
            cursor = projects[^1].Id;

            foreach (var project in projects)
                database.Entry(project).State = EntityState.Detached;
        }

        // Immutable editions retain their audit snapshots but their links can never be restored
        var editions = database.Publications.FromSqlInterpolated($"""
            SELECT * FROM publications
            WHERE asset_references @> jsonb_build_array(jsonb_build_object('assetId', {assetId}))
            """).Select(edition => edition.Id);
        await database.PublicationAccess.Where(state => editions.Contains(state.PublicationId))
            .ExecuteUpdateAsync(update => update.SetProperty(state => state.Deleted, true), token);
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO retired_publication_ids (id)
            SELECT id FROM publications
            WHERE asset_references @> jsonb_build_array(jsonb_build_object('assetId', {assetId}))
            ON CONFLICT DO NOTHING
            """, token);
        asset.Hidden = true;
        asset.Deleted = true;
        asset.RemovedFromProjects = true;
        await database.SaveChangesAsync(token);
        return Record(asset);
    }

    // Derive available actions from confirmed lifecycle state and expose inspection only through the admin route
    public static AssetAdministrationRecord Record(AssetCandidate asset) => new(asset.Id, asset.CatalogueName ?? asset.Name, asset.Kind, asset.CatalogueCategory ?? asset.Category,
        asset.Status, asset.Hidden, asset.Deleted, asset.RemovedFromProjects, null,
        JsonSerializer.Deserialize<string[]>(asset.ValidationJson) ?? [],
        asset.Deleted ? (asset.RemovedFromProjects || asset.Status != "approved" ? [] : ["remove"])
            : asset.Status == "approved" ? [asset.Hidden ? "show" : "hide", "delete"] : ["delete"], asset.Sha256, asset.CatalogueSource ?? asset.Source,
        asset.CatalogueLicense ?? asset.License, asset.CatalogueReviewNotes ?? asset.ReviewNotes, $"{ApiV1Endpoints.Prefix}/admin/assets/{asset.Id}/bytes", asset.Tags);
}
