using System.Text.Json.Serialization;

namespace Spatia.Server.Publications;

/// <summary>
/// Pins an authored asset ID to immutable bytes; catalogue approval and delivery remain separate concerns
/// </summary>
public sealed record PublicationAssetReference
{
    /// <summary>Creates a reference from an approved resolver's asset ID and SHA-256 content identity</summary>
    /// <remarks>Structural validation here is not evidence of approval, byte availability or retention</remarks>
    public PublicationAssetReference(string assetId, string sha256)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(assetId);
        ArgumentNullException.ThrowIfNull(sha256);
        if (sha256.Length != 64 || sha256.Any(character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException("An asset SHA-256 must contain exactly 64 hexadecimal characters.", nameof(sha256));
        }

        AssetId = assetId;
        Sha256 = sha256.ToLowerInvariant();
    }

    /// <summary>Gets the exact case-sensitive authored asset ID</summary>
    [JsonPropertyName("assetId")]
    public string AssetId { get; }

    /// <summary>Gets the lowercase SHA-256 digest identifying the pinned bytes</summary>
    [JsonPropertyName("sha256")]
    public string Sha256 { get; }
}
