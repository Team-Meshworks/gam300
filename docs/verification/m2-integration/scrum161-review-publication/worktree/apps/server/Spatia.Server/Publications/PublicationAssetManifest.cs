using System.Text.Json;

namespace Spatia.Server.Publications;

/// <summary>Serializes a complete, deterministic set of immutable references for a publication row</summary>
public static class PublicationAssetManifest
{
    /// <summary>Rejects duplicate IDs and serializes references in ordinal asset-ID order</summary>
    /// <remarks>The coordinator must separately prove that the set covers the entire validated document</remarks>
    public static string Serialize(IEnumerable<PublicationAssetReference> references)
    {
        ArgumentNullException.ThrowIfNull(references);
        var byId = new SortedDictionary<string, PublicationAssetReference>(StringComparer.Ordinal);
        foreach (var reference in references)
        {
            ArgumentNullException.ThrowIfNull(reference);
            if (!byId.TryAdd(reference.AssetId, reference))
            {
                throw new ArgumentException("Each publication asset ID must occur exactly once.", nameof(references));
            }
        }
        return JsonSerializer.Serialize(byId.Values);
    }
}
