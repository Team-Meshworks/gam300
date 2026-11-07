using System.Collections.Frozen;
using System.Text.Json;

namespace Spatia.ProjectFormat;

// Keep publication checks aligned with the visitor build
public static class PublicationCapabilities
{
    public static IReadOnlySet<string> Supported { get; } = Read();

    private static FrozenSet<string> Read()
    {
        // Embed the shared list so deployment does not depend on a loose configuration file
        using var stream = typeof(PublicationCapabilities).Assembly.GetManifestResourceStream("Spatia.PublicationCapabilities")
            ?? throw new InvalidOperationException("Publication capability profile is missing.");
        return (JsonSerializer.Deserialize<string[]>(stream)
            ?? throw new InvalidOperationException("Publication capability profile is invalid.")).ToFrozenSet(StringComparer.Ordinal);
    }
}
