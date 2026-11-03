using System.Collections.Frozen;
using System.Text.Json;
using Spatia.ProjectFormat;
using Format = Spatia.ProjectFormat.ProjectFormat;

namespace Spatia.Server.Projects;

/// <summary>
/// Validates authored documents against the server's packaged, environment-appropriate catalogue
/// </summary>
public sealed class ProjectDocumentService
{
    private readonly IReadOnlyDictionary<string, string> _assets;

    /// <summary>
    /// Uses the same development catalogue as the editor; other environments fail closed
    /// </summary>
    public ProjectDocumentService(IHostEnvironment environment)
    {
        // shortcut: No production assets are approved yet, add the approved catalogue with its delivery policy
        if (!environment.IsDevelopment())
        {
            _assets = FrozenDictionary<string, string>.Empty;
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
                or "display-rectangle-panel-v1" or "display-square-stand-v1"))
            {
                continue;
            }
            var kind = entry.GetProperty("kind").GetString()!;
            if (entry.GetProperty("access").GetString() != "development-only"
                || kind != (id == "test-room-v1" ? "environment" : "model") || !assets.TryAdd(id, kind))
            {
                throw new InvalidOperationException("Invalid packaged development asset catalogue.");
            }
        }
        if (assets.Count != 11)
        {
            throw new InvalidOperationException("The packaged development asset catalogue is incomplete.");
        }
        _assets = assets.ToFrozenDictionary(StringComparer.Ordinal);
    }

    /// <summary>
    /// Checks original upload bytes, complete content, asset references and route identity
    /// </summary>
    public FormatResult<IAuthoredProject> Read(Guid projectId, string json) => Bind(projectId, Read(json));

    /// <summary>
    /// Validates an imported document before creation assigns a new server-owned project identifier
    /// </summary>
    public FormatResult<IAuthoredProject> Read(string json) => Format.Deserialize(json, _assets);

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
