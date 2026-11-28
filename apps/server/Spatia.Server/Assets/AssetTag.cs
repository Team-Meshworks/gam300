using System.Text;

namespace Spatia.Server.Assets;

/// <summary>One shared catalogue tag that administrators can attach to assets</summary>
public sealed class AssetTag
{
    // The comparison key keeps near-duplicates such as "Post war" and "post-war" as one tag
    public required string Key
    {
        get; set;
    }
    public required string Name
    {
        get; set;
    }
    // Seeded starter tags have no creator
    public Guid? CreatedBy
    {
        get; set;
    }
    public DateTimeOffset CreatedAt
    {
        get; set;
    }
}

/// <summary>Bounds and normalisation shared by intake, editing and the browser policy</summary>
public static class AssetTags
{
    public const int MaxPerAsset = 10;
    public const int MaxLength = 40;
    public static readonly string[] Starter = ["Post-war", "Japanese Occupation", "Early Singapore", "Modern Singapore"];

    /// <summary>Trims and collapses whitespace, or returns null for a tag that cannot be stored</summary>
    public static string? Normalize(string? tag)
    {
        if (tag is null)
            return null;
        var name = string.Join(' ', tag.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return name.Length is > 0 and <= MaxLength && Key(name).Length > 0
            // Whole code points, so supplementary letters such as CJK Extension B match the browser's \p{L}
            && name.EnumerateRunes().All(rune => Rune.IsLetterOrDigit(rune) || rune.Value is ' ' or '-' or '\'' or '&' or '(' or ')' or '.' or ',')
            ? name
            : null;
    }

    /// <summary>Case, spacing and punctuation never distinguish two tags</summary>
    public static string Key(string name) =>
        string.Concat(name.EnumerateRunes().Where(Rune.IsLetterOrDigit).Select(rune => Rune.ToLowerInvariant(rune).ToString()));

    /// <summary>Normalises a request, merging duplicates in order, or returns null when any tag is invalid</summary>
    public static string[]? Read(IReadOnlyCollection<string?>? tags)
    {
        if (tags is null)
            return [];
        if (tags.Count > MaxPerAsset)
            return null;
        var names = new List<string>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tag in tags)
        {
            if (Normalize(tag) is not { } name)
                return null;
            if (keys.Add(Key(name)))
                names.Add(name);
        }
        return [.. names];
    }
}
