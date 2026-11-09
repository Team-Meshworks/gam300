using System.Data;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Assets;

/// <summary>Owns private intake and ordinary retirement without changing existing authored documents</summary>
public sealed class AssetAdministrationService(ApplicationDbContext database, AssetUploadValidator validator)
{

    // Load metadata without allocating every retained GLB for the administrative list
    public async Task<AssetAdministrationRecord[]> ListAsync(CancellationToken token) =>
        (await database.AssetCandidates.AsNoTracking().OrderByDescending(asset => asset.CreatedAt)
            .Select(asset => new AssetCandidate
            {
                Id = asset.Id,
                Name = asset.Name,
                Kind = asset.Kind,
                Category = asset.Category,
                Sha256 = asset.Sha256,
                Bytes = Array.Empty<byte>(),
                Status = asset.Status,
                ValidationJson = asset.ValidationJson,
                Hidden = asset.Hidden,
                Deleted = asset.Deleted,
                RemovedFromProjects = asset.RemovedFromProjects,
                Source = asset.Source,
                License = asset.License,
                ReviewNotes = asset.ReviewNotes,
            }).Take(1000).ToArrayAsync(token)).Select(Record).ToArray();

    public async Task<AssetAdministrationRecord?> SubmitAsync(string name, string kind, string? category,
        byte[] bytes, Guid actor, AssetReviewRequest? metadata, CancellationToken token)
    {

        // Repeat input bounds here because the service can be called outside the HTTP upload handler
        if (!AssetIntakePolicy.Accepts(name, kind, category) || bytes.Length is < 1 or > AssetIntakePolicy.MaxBytes || actor == Guid.Empty)
        {
            return null;
        }

        // Validate privately before allocating an immutable identity or admitting another stored upload
        var validation = kind == "audio" ? AssetAudioValidator.Validate(bytes) : await validator.ValidateAsync(bytes, token);
        if (validation is null)
        {
            return null;
        }

        // A valid administrator upload is immediately selectable; failed validation stays private
        // Fingerprint the exact uploaded bytes once and retain that version through later retirement
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = name[..^4],
            Kind = kind,
            Category = category,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
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

        // Serialize quota admission across requests before adding another persistent upload
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, token);
        await database.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(167168)", token);
        var count = await database.AssetCandidates.CountAsync(token);
        var total = await database.AssetCandidates.SumAsync(item => (long?)item.Bytes.Length, token) ?? 0;
        if (count >= 1000 || total + bytes.Length > 1024L * 1024 * 1024)
        {
            return null;
        }

        // Persist only after quota admission; disposal rolls the transaction back on every earlier return
        database.AssetCandidates.Add(asset);
        await database.SaveChangesAsync(token);
        await transaction.CommitAsync(token);
        return Record(asset);
    }

    public async Task<AssetAdministrationRecord?> ReviewAsync(Guid id, AssetReviewRequest review, Guid actor, CancellationToken token)
    {

        // Record the explicit administrator decision; omitted details use empty strings for the stored approval contract
        var changed = await database.AssetCandidates.Where(asset => asset.Id == id && !asset.Deleted && asset.Status == "pending")
            .ExecuteUpdateAsync(update => update.SetProperty(asset => asset.Status, "approved")
                .SetProperty(asset => asset.Hidden, false).SetProperty(asset => asset.Source, review.Source ?? "")
                .SetProperty(asset => asset.License, review.License ?? "").SetProperty(asset => asset.ReviewNotes, review.ReviewNotes ?? "")
                .SetProperty(asset => asset.ReviewedBy, actor), token);

        // Return the persisted record so the client replaces its state only after the database accepts review
        return changed == 1 ? Record((await database.AssetCandidates.AsNoTracking().SingleAsync(asset => asset.Id == id, token))) : null;
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
        return changed == 1 ? Record(await database.AssetCandidates.AsNoTracking().SingleAsync(asset => asset.Id == id, token)) : null;
    }

    // The caller owns the transaction and checks live administrator authority before committing
    public async Task<AssetAdministrationRecord?> RemoveAsync(Guid id,
        ProjectDocumentService documents, CancellationToken token)
    {
        // Block project creation, writes and row-locking publication/review operations during the global change
        await database.Database.ExecuteSqlRawAsync("LOCK TABLE projects IN EXCLUSIVE MODE", token);
        var asset = await database.AssetCandidates.FromSqlInterpolated($"SELECT * FROM asset_candidates WHERE id = {id} FOR UPDATE")
            .SingleOrDefaultAsync(token);
        if (asset is null || asset.Status != "approved" || asset.RemovedFromProjects || !asset.Deleted) { return null; }
        var assetId = id.ToString("D");
        var pattern = "%" + assetId + "%";
        // Page matching drafts while the table lock keeps the set stable without retaining every document in memory
        var cursor = Guid.Empty;
        while (true)
        {
            var projects = await database.Projects.FromSqlInterpolated($"""
                SELECT * FROM projects WHERE document::text LIKE {pattern} AND id > {cursor} ORDER BY id LIMIT 10
                """).ToArrayAsync(token);
            if (projects.Length == 0) { break; }
            foreach (var project in projects)
            {
                if (!AssetDocumentReferences.Read(project.DocumentJson).Contains(assetId)) { continue; }
                if (project.Revision == Project.MaxRevision || !documents.ReadStored(project.Id, project.SchemaVersion, project.DocumentJson).Ok) { return null; }
                var removed = AssetDocumentRemoval.Remove(project.DocumentJson, assetId);
                using var parsed = JsonDocument.Parse(removed);
                var version = parsed.RootElement.GetProperty("schemaVersion").GetInt32();
                if (!documents.ReadStored(project.Id, version, removed).Ok) { return null; }
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
            foreach (var project in projects) { database.Entry(project).State = EntityState.Detached; }
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
    public static AssetAdministrationRecord Record(AssetCandidate asset) => new(asset.Id, asset.Name, asset.Kind, asset.Category,
        asset.Status, asset.Hidden, asset.Deleted, asset.RemovedFromProjects, null,
        JsonSerializer.Deserialize<string[]>(asset.ValidationJson) ?? [],
        asset.Deleted ? (asset.RemovedFromProjects || asset.Status != "approved" ? [] : ["remove"])
            : asset.Status == "approved" ? [asset.Hidden ? "show" : "hide", "delete"] : ["delete"], asset.Sha256, asset.Source, asset.License, asset.ReviewNotes, $"{ApiV1Endpoints.Prefix}/admin/assets/{asset.Id}/bytes");
}
