using System.Text.Json;
using Spatia.ProjectFormat;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Reviews;

internal sealed record ReviewAssetReference(string AssetId, string Sha256);

/// <summary>The asset owner resolves retained immutable identities; absence must deny submission.</summary>
internal interface IReviewAssetResolver
{
    // Resolve approved, retained bytes in the caller's transaction without committing or changing it.
    Task<IReadOnlyCollection<ReviewAssetReference>?> ResolveAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        IReadOnlySet<string> assetIds, CancellationToken cancellationToken);
}

internal sealed class UnavailableReviewAssetResolver : IReviewAssetResolver
{
    public Task<IReadOnlyCollection<ReviewAssetReference>?> ResolveAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        IReadOnlySet<string> assetIds, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyCollection<ReviewAssetReference>?>(null);
}

internal static class ReviewAssetManifest
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    internal static HashSet<string> Required(IAuthoredProject document)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        switch (document)
        {
            case LegacyProject { SchemaVersion: 1 } legacy:
                foreach (var scene in legacy.Scenes)
                {
                    ids.Add(scene.EnvironmentAssetId);
                    foreach (var item in scene.Objects) { ids.Add(item.AssetId); }
                }
                break;
            case ContentProject { SchemaVersion: 2 } content:
                foreach (var scene in content.Scenes)
                {
                    ids.Add(scene.EnvironmentAssetId);
                    foreach (var item in scene.Objects)
                    {
                        ids.Add(item.AssetId);
                        foreach (var component in item.Components)
                        {
                            switch (component)
                            {
                                case ImageComponent image: ids.Add(image.AssetId); break;
                                case AudioComponent audio: ids.Add(audio.AssetId); break;
                                case VideoComponent video: ids.Add(video.AssetId); break;
                            }
                        }
                    }
                }
                break;
            default: throw new ArgumentException("A validated supported document is required.", nameof(document));
        }
        return ids;
    }

    internal static string? Serialize(IReadOnlySet<string> required, IReadOnlyCollection<ReviewAssetReference>? resolved)
    {
        if (resolved is null || resolved.Count != required.Count) { return null; }
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var reference in resolved)
        {
            if (reference is null || !required.Contains(reference.AssetId) || !ids.Add(reference.AssetId)
                || reference.Sha256 is null || reference.Sha256.Length != 64
                || reference.Sha256.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            {
                return null;
            }
        }
        return JsonSerializer.Serialize(resolved.OrderBy(row => row.AssetId, StringComparer.Ordinal), Options);
    }
}
