namespace Spatia.Server.Assets;

/// <summary>Defines the accepted asset formats and agreed catalogue categories</summary>
public static class AssetIntakePolicy
{

    // Share one body cap and the agreed model categories across intake, review and the browser policy
    // Spaces deliberately have no category list
    public const int MaxBytes = 20 * 1024 * 1024;
    public static readonly string[] ModelCategories = ["Objects", "Furniture", "Architecture", "Clothing", "Tools & Equipment"];
    public static readonly string[] AudioCategories = ["BGM"];

    public static string MediaType(string kind) => kind == "audio" ? "audio/mp4" : "model/gltf-binary";
    public static string Extension(string kind) => kind == "audio" ? ".m4a" : ".glb";

    // File names are display metadata only and never become disk paths or immutable identities
    public static bool Accepts(string name, string kind, string? category) =>
        name.Length is > 4 and <= 120 && !string.IsNullOrWhiteSpace(name[..^4])
        && name.EndsWith(Extension(kind), StringComparison.OrdinalIgnoreCase)
        && !name.Any(character => char.IsControl(character) || character is '/' or '\\' or ':')
        && !name.Contains("..", StringComparison.Ordinal)
        && (kind == "environment" ? category is null
            : kind == "model" ? ModelCategories.Contains(category, StringComparer.Ordinal)
            : kind == "audio" && AudioCategories.Contains(category, StringComparer.Ordinal));
}
