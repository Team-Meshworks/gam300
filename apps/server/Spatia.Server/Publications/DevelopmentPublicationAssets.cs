using System.Security.Cryptography;
using System.Text.Json;

namespace Spatia.Server.Publications;

// Packaged development assets are captured privately with an edition; production never resolves them
internal sealed class DevelopmentPublicationAssets(IHostEnvironment environment, IConfiguration configuration)
{
    internal sealed record Asset(string Id, string Kind, string MediaType, string Sha256, string Path, int Size, string? Placement);

    internal async Task<Asset?> ReadAsync(string id, CancellationToken cancellationToken)
    {
        if (!environment.IsDevelopment() || id.Length is < 1 or > 128
            || id[0] is not (>= 'a' and <= 'z') and not (>= '0' and <= '9')
            || id.Any(c => c is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '-')) { return null; }
        try
        {
            using var stream = typeof(DevelopmentPublicationAssets).Assembly.GetManifestResourceStream("Spatia.Assets.Manifest");
            if (stream is null) { return null; }
            using var manifest = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var entries = manifest.RootElement.GetProperty("assets").EnumerateArray()
                .Where(entry => entry.GetProperty("assetId").GetString() == id).ToArray();
            if (entries.Length != 1) { return null; }
            var entry = entries[0];
            var kind = entry.GetProperty("kind").GetString();
            var media = entry.GetProperty("mediaType").GetString();
            var digest = entry.GetProperty("sha256").GetString();
            var file = entry.GetProperty("file").GetString();
            var size = entry.GetProperty("byteSize").GetInt64();
            var placement = entry.TryGetProperty("placement", out var placementValue) ? placementValue.GetString() : null;
            if (entry.GetProperty("access").GetString() != "development-only"
                || kind is not ("environment" or "model" or "image" or "audio" or "video")
                || media is not ("model/gltf-binary" or "image/webp" or "audio/mp4" or "video/webm")
                || digest is null || digest.Length != 64 || digest.Any(c => c is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                || placement is not (null or "bottom-center")
                || (placement is not null && kind is not ("environment" or "model"))
                || file is null || !file.StartsWith("delivery/", StringComparison.Ordinal)
                || size is < 1 or > 104857600) { return null; }
            var root = Path.GetFullPath(configuration["DevelopmentPublication:AssetDirectory"]
                ?? Path.Combine(AppContext.BaseDirectory, "development-assets"));
            var path = Path.GetFullPath(Path.Combine(root, file["delivery/".Length..]));
            var relative = Path.GetRelativePath(root, path);
            if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            { return null; }
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != size) { return null; }
            await using var content = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
            var actual = await SHA256.HashDataAsync(content, cancellationToken);
            return Convert.ToHexStringLower(actual) == digest && content.Length == size
                ? new Asset(id, kind, media, digest, path, checked((int)size), placement) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException)
        { return null; }
    }

    internal static async Task<byte[]?> ReadBytesAsync(Asset asset, CancellationToken cancellationToken)
    {
        try
        {
            await using var content = new FileStream(asset.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
            if (content.Length != asset.Size) { return null; }
            var bytes = new byte[asset.Size];
            await content.ReadExactlyAsync(bytes, cancellationToken);
            return content.Length == asset.Size && Convert.ToHexStringLower(SHA256.HashData(bytes)) == asset.Sha256
                ? bytes : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { return null; }
    }
}
