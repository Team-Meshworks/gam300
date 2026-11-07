using System.Collections.Frozen;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.ProjectFormat;
using Format = Spatia.ProjectFormat.ProjectFormat;

namespace Spatia.Server.Projects;

/// <summary>
/// Validates authored documents against reviewed retained assets and environment-appropriate development samples
/// </summary>
public sealed class ProjectDocumentService
{
    private readonly IReadOnlyDictionary<string, string> _assets;
    private readonly HashSet<string> _retired = new(StringComparer.Ordinal);

    /// <summary>
    /// Reads approved asset identities for this request and adds packaged samples only in development
    /// </summary>
    public ProjectDocumentService(IHostEnvironment environment, ApplicationDbContext? database = null)
    {
        // Read one request-scoped catalogue view; retirement prevents new references but preserves stored ones
        var approved = database?.AssetCandidates.AsNoTracking().Where(asset => asset.Status == "approved")
            .Select(asset => new { asset.Id, asset.Kind, asset.Hidden, asset.Deleted }).ToArray();
        var retained = approved?.ToDictionary(asset => asset.Id.ToString(), asset => asset.Kind, StringComparer.Ordinal)
            ?? new Dictionary<string, string>(StringComparer.Ordinal);
        if (approved is not null)
        {
            foreach (var asset in approved.Where(asset => asset.Hidden || asset.Deleted)) { _retired.Add(asset.Id.ToString()); }
        }
        // Retired approved identities remain valid for stored documents and serialization
        if (!environment.IsDevelopment())
        {
            _assets = retained.ToFrozenDictionary(StringComparer.Ordinal);
            return;
        }

        using var stream = typeof(ProjectDocumentService).Assembly.GetManifestResourceStream("Spatia.Assets.Manifest")!;
        using var manifest = JsonDocument.Parse(stream);
        var assets = new Dictionary<string, string>(StringComparer.Ordinal);
        if (manifest.RootElement.GetProperty("schemaVersion").GetInt32() != 1)
        {
            throw new InvalidOperationException("Unsupported packaged asset catalogue.");
        }
        foreach (var entry in manifest.RootElement.GetProperty("assets").EnumerateArray())
        {
            var id = entry.GetProperty("assetId").GetString()!;
            // Repeated rooms reuse the room bytes as model instances; keep their manifest identity saveable
            if (id is not ("test-room-v1" or "test-room-module-v1" or "test-crate-v1" or "sample-snowglobe-v1"
                or "display-cube-v1" or "display-full-glass-case-v1" or "display-half-glass-case-v1"
                or "display-one-sided-glass-case-v1" or "display-rectangle-stand-v1"
                or "furniture-modern-bench-1-v1" or "furniture-modern-bench-2-v1" or "library-untitled-v1"
                or "room-space1-v1" or "room-doors-1-v1" or "room-doors-2-v1" or "room-doors-3-v1" or "room-doors-4-v1"
                or "room-doors-1-2-v1" or "room-doors-1-3-v1" or "room-doors-1-4-v1"
                or "room-doors-2-3-v1" or "room-doors-2-4-v1" or "room-doors-3-4-v1"
                or "room-doors-1-2-3-v1" or "room-doors-1-2-4-v1" or "room-doors-1-3-4-v1"
                or "room-doors-2-3-4-v1" or "room-doors-1-2-3-4-v1"
                or "room-space1-module-v1" or "room-doors-1-module-v1" or "room-doors-2-module-v1" or "room-doors-3-module-v1" or "room-doors-4-module-v1"
                or "room-doors-1-2-module-v1" or "room-doors-1-3-module-v1" or "room-doors-1-4-module-v1" or "room-doors-2-3-module-v1" or "room-doors-2-4-module-v1" or "room-doors-3-4-module-v1"
                or "room-doors-1-2-3-module-v1" or "room-doors-1-2-4-module-v1" or "room-doors-1-3-4-module-v1" or "room-doors-2-3-4-module-v1" or "room-doors-1-2-3-4-module-v1"
                or "display-rectangle-panel-v1" or "display-square-stand-v1" or "display-square-panel-v1" or "sample-landscape-image-v1" or "sample-coast-image-v1" or "sample-coast-video-v1"
                or "sample-dunes-image-v1" or "sample-forest-image-v1" or "sample-sunset-image-v1" or "sample-valley-image-v1" or "sample-dunes-video-v1" or "sample-forest-video-v1" or "sample-sunset-video-v1"
                or "audio-ethereal-calm-v1"
                or "audio-mystic-harp-v1"
                or "audio-calm-piano-v1"
                or "audio-mysterious-piano-v1"
                or "audio-reflective-piano-v1"
                or "audio-classical-piano-v1"
                or "audio-octave-piano-loop-v1"
                or "audio-museum-hall-v1"
                or "audio-museum-hall-conversation-v1"
                or "audio-washroom-room-tone-v1"
                or "audio-wooden-cabin-at-night-v1"
                or "audio-outdoor-restaurant-v1"
                or "audio-quiet-crowd-v1"))
            {
                continue;
            }
            var kind = entry.GetProperty("kind").GetString()!;
            var expectedKind = id is "audio-ethereal-calm-v1" or "audio-mystic-harp-v1" or "audio-calm-piano-v1" or "audio-mysterious-piano-v1" or "audio-reflective-piano-v1" or "audio-classical-piano-v1" or "audio-octave-piano-loop-v1" or "audio-museum-hall-v1" or "audio-museum-hall-conversation-v1" or "audio-washroom-room-tone-v1" or "audio-wooden-cabin-at-night-v1" or "audio-outdoor-restaurant-v1" or "audio-quiet-crowd-v1" ? "audio"
                : id is "sample-landscape-image-v1" or "sample-coast-image-v1" or "sample-dunes-image-v1" or "sample-forest-image-v1" or "sample-sunset-image-v1" or "sample-valley-image-v1" ? "image"
                : id is "sample-coast-video-v1" or "sample-dunes-video-v1" or "sample-forest-video-v1" or "sample-sunset-video-v1" ? "video"
                : id is "test-room-v1" or "room-space1-v1" or "room-doors-1-v1" or "room-doors-2-v1" or "room-doors-3-v1" or "room-doors-4-v1"
                    or "room-doors-1-2-v1" or "room-doors-1-3-v1" or "room-doors-1-4-v1" or "room-doors-2-3-v1" or "room-doors-2-4-v1" or "room-doors-3-4-v1"
                    or "room-doors-1-2-3-v1" or "room-doors-1-2-4-v1" or "room-doors-1-3-4-v1" or "room-doors-2-3-4-v1" or "room-doors-1-2-3-4-v1" ? "environment" : "model";
            if (entry.GetProperty("access").GetString() != "development-only"
                || kind != expectedKind || !assets.TryAdd(id, kind))
            {
                throw new InvalidOperationException("Invalid packaged development asset catalogue.");
            }
        }
        if (assets.Count != 70)
        {
            throw new InvalidOperationException("The packaged development asset catalogue is incomplete.");
        }
        foreach (var asset in retained) { assets.Add(asset.Key, asset.Value); }
        _assets = assets.ToFrozenDictionary(StringComparer.Ordinal);
    }

    /// <summary>
    /// Checks original upload bytes, complete content, asset references and route identity
    /// </summary>
    public FormatResult<IAuthoredProject> Read(Guid projectId, string json, string? existingJson = null)
    {
        var parsed = Bind(projectId, Format.Deserialize(json, _assets));
        if (!parsed.Ok) { return parsed; }
        // Permit a retired version only when the confirmed saved document already references it
        var existing = existingJson is null ? new HashSet<string>() : AssetDocumentReferences.Read(existingJson);
        return AssetDocumentReferences.Read(json).Any(id => _retired.Contains(id) && !existing.Contains(id))
            ? new(null, new("project", "Retired assets cannot be added to a project")) : parsed;
    }

    /// <summary>
    /// Validates an imported document before creation assigns a new server-owned project identifier
    /// </summary>
    public FormatResult<IAuthoredProject> Read(string json)
    {
        var parsed = Format.Deserialize(json, _assets);
        return parsed.Ok && AssetDocumentReferences.Read(json).Any(_retired.Contains)
            ? new(null, new("project", "Retired assets cannot be selected for a new project")) : parsed;
    }

    /// <summary>
    /// Validates stored values without renormalizing or treating jsonb expansion as upload bytes
    /// </summary>
    public FormatResult<IAuthoredProject> ReadStored(Guid projectId, int schemaVersion, string json)
    {
        try
        {
            using var parsed = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = Format.MaxJsonDepth });
            var result = Bind(projectId, Format.ValidateStored(parsed.RootElement, _assets));
            return result.Ok && result.Value!.SchemaVersion != schemaVersion
                ? new(null, new("project.schemaVersion", "Stored project format does not match its metadata")) : result;
        }
        catch (JsonException)
        {
            return new(null, new("project", "Stored project JSON is invalid"));
        }
    }

    /// <summary>
    /// Produces the bounded normalized representation used for storage and export
    /// </summary>
    public FormatResult<string> Serialize(IAuthoredProject document) => Format.Serialize(document, _assets);

    private static FormatResult<IAuthoredProject> Bind(Guid projectId, FormatResult<IAuthoredProject> result) =>
        result.Ok && Guid.Parse(result.Value!.ProjectId) != projectId
            ? new(null, new("project.projectId", "Document project ID does not match the route")) : result;
}
