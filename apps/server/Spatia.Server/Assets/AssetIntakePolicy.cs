namespace Spatia.Server.Assets;

/// <summary>Defines the accepted asset formats and agreed catalogue categories</summary>
public static class AssetIntakePolicy
{
    // Share one body cap and the agreed model categories across intake, review and the browser policy
    // Spaces deliberately have no category list
    public const int MaxBytes = 20 * 1024 * 1024;
    public const int CatalogueLimit = 100000;

    public static int MaxRetainedAssets(IConfiguration configuration)
    {
        var limit = configuration.GetValue("AssetIntake:MaxRetainedAssets", 1000);
        return limit is > 0 and <= CatalogueLimit ? limit : throw new InvalidOperationException("AssetIntake:MaxRetainedAssets must be between 1 and 100000.");
    }

    public static long MaxRetainedBytes(IConfiguration configuration)
    {
        var limit = configuration.GetValue("AssetIntake:MaxRetainedBytes", 1024L * 1024 * 1024);
        return limit > 0 ? limit : throw new InvalidOperationException("AssetIntake:MaxRetainedBytes must be positive.");
    }

    public static readonly string[] ModelCategories = ["Objects", "Furniture", "Architecture", "Clothing", "Tools & Equipment"];
    public static readonly string[] AudioCategories = ["BGM"];

    public static string MediaType(string kind) => kind == "audio" ? "audio/mp4" : "model/gltf-binary";

    public static string Extension(string kind) => kind == "audio" ? ".m4a" : ".glb";

    public static bool ValidDisplayName(string? name) =>
        !string.IsNullOrWhiteSpace(name) && name.Length <= 120 && !name.Any(char.IsControl);

    public static bool AcceptsCategory(string kind, string? category) => kind switch
    {
        "environment" => category is null,
        "model" => ModelCategories.Contains(category, StringComparer.Ordinal),
        "audio" => AudioCategories.Contains(category, StringComparer.Ordinal),
        _ => false
    };

    // File names are display metadata only and never become disk paths or immutable identities
    public static bool Accepts(string name, string kind, string? category) =>
        name.Length is > 4 and <= 120 && !string.IsNullOrWhiteSpace(name[..^4])
        && name.EndsWith(Extension(kind), StringComparison.OrdinalIgnoreCase)
        && !name.Any(character => char.IsControl(character) || character is '/' or '\\' or ':')
        && !name.Contains("..", StringComparison.Ordinal)
        && AcceptsCategory(kind, category);
}
