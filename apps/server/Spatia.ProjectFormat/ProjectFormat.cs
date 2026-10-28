using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

public static partial class ProjectFormat
{
    // The entry points below share one pipeline: parse, check structure, resolve references and normalize
    // Keep these limits and variant checks aligned with the browser's shared project module
    public const int MaxProjectBytes = 5 * 1024 * 1024;
    public const int MaxJsonDepth = 32;
    // Keep field spelling strict and route output through the shared string and number rules
    // Variant metadata may appear anywhere in an imported object
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        AllowOutOfOrderMetadataProperties = true,
        MaxDepth = MaxJsonDepth,
        Converters = { new ExactStringConverter(), new BrowserNumberConverter() },
    };

    // Carry the first rejected field through nested readers without returning partially checked data
    private sealed class InvalidFormat(string path, string message) : Exception(message)
    {
        public string Path { get; } = path;
    }

    private static void Fail(string path, string message) => throw new InvalidFormat(path, message);
    private static FormatResult<T> Rejected<T>(string path, string message) => new(default, new(path, message));

    // Return a separate checked document; callers replace drafts only after Ok
    public static FormatResult<IAuthoredProject> Deserialize(string? text, IReadOnlyDictionary<string, string> assets)
    {
        if (text is null)
        {
            return Rejected<IAuthoredProject>("project", "Expected project JSON text");
        }

        // Reject oversized input before allocating a JSON tree; Unicode can use several bytes per character
        if (text.Length > MaxProjectBytes || Encoding.UTF8.GetByteCount(text) > MaxProjectBytes)
        {
            return Rejected<IAuthoredProject>("project", "Project JSON exceeds the 5 MiB file limit");
        }

        try
        {
            using var parsed = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = MaxJsonDepth });
            return Validate(parsed.RootElement, assets);
        }
        catch (JsonException)
        {
            return Rejected<IAuthoredProject>("project", "Project JSON is malformed or exceeds the nesting limit");
        }
        catch (ArgumentException)
        {
            return Rejected<IAuthoredProject>("project", "Project JSON contains invalid text");
        }
    }

    /// <summary>
    /// Reconstructs parsed data with the same content and serialized-byte limits as imports
    /// </summary>
    /// <remarks>
    /// Uploads must use Deserialize to bound original bytes before parsing
    /// Stored jsonb can expand numbers and whitespace without changing the authored document
    /// </remarks>
    public static FormatResult<IAuthoredProject> Validate(JsonElement root, IReadOnlyDictionary<string, string> assets)
    {
        try
        {
            // Reject duplicate names before property lookup can hide an earlier value
            try { DuplicateFields(root); }
            catch (InvalidOperationException) { Fail("project", "Project JSON contains invalid Unicode"); }
            if (root.ValueKind != JsonValueKind.Object)
            {
                Fail("project", "Project must be an object");
            }

            // Choose the released contract before reading version-specific collections
            if (!root.TryGetProperty("schemaVersion", out var versionValue))
            {
                Fail("project.schemaVersion", "Required field is missing");
            }

            if (versionValue.ValueKind != JsonValueKind.Number || !versionValue.TryGetDouble(out var version) || (version != 1 && version != 2))
            {
                Fail("project.schemaVersion", "Unsupported project format");
            }

            var content = versionValue.GetDouble() == 2;
            // Validate every field shape before the reference pass relies on typed property access
            Structure(root, content);

            // Caller dictionary comparers must not change the wire contract's asset identity
            var registry = assets.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
            References(root, content, registry);

            // Root construction also accepts equivalent JSON numbers such as schemaVersion 2.0
            var scenes = Get(root, "scenes").GetRawText();
            IAuthoredProject value = content
                ? new ContentProject(2, String(root, "projectId"), String(root, "title"), JsonSerializer.Deserialize<ContentScene[]>(scenes, JsonOptions)!)
                : new LegacyProject(1, String(root, "projectId"), String(root, "title"), JsonSerializer.Deserialize<LegacyScene[]>(scenes, JsonOptions)!);

            // Older files may omit scene hotspots and interactions; store empty lists for later edits
            value = value switch
            {
                LegacyProject legacy => legacy with
                {
                    Scenes = legacy.Scenes.Select(scene => scene with
                    {
                        Hotspots = scene.Hotspots ?? [],
                        Interactions = scene.Interactions ?? [],
                    }).ToArray(),
                },
                ContentProject contentProject => contentProject with
                {
                    Scenes = contentProject.Scenes.Select(scene => scene with
                    {
                        Hotspots = scene.Hotspots ?? [],
                        Interactions = scene.Interactions ?? [],
                    }).ToArray(),
                },
                _ => value,
            };

            // Normalize only the newly constructed copy, then check its actual saved byte budget
            Normalize(value);
            if (Encoding.UTF8.GetByteCount(Encode(value)) > MaxProjectBytes)
            {
                Fail("project", "Project exceeds the 5 MiB document limit");
            }

            return new(value, null);
        }
        // Return validation feedback without exposing parser internals or a partially built project
        catch (InvalidFormat error)
        {
            return Rejected<IAuthoredProject>(error.Path, error.Message);
        }
        catch (JsonException)
        {
            return Rejected<IAuthoredProject>("project", "Project JSON is malformed or exceeds the nesting limit");
        }
        catch (ArgumentException)
        {
            return Rejected<IAuthoredProject>("project", "Project JSON contains invalid text");
        }
    }

    public static FormatResult<string> Serialize(IAuthoredProject? value, IReadOnlyDictionary<string, string> assets)
    {
        // Typed records can still contain invalid values; save through the same import checks
        if (value is null)
        {
            return Rejected<string>("project", "Expected a project");
        }

        try
        {
            // Reopening creates the normalized checked copy and leaves the caller's arrays untouched
            var result = Deserialize(Encode(value), assets);
            return result.Ok ? new(Encode(result.Value!), null) : new(null, result.Error);
        }
        catch (JsonException)
        {
            return Rejected<string>("project", "Project cannot be serialized");
        }
        catch (ArgumentException)
        {
            return Rejected<string>("project", "Project cannot be serialized");
        }
        catch (NotSupportedException)
        {
            return Rejected<string>("project", "Project contains unsupported model types");
        }
    }

    private static string Encode(IAuthoredProject value) => JsonSerializer.Serialize(value, value.GetType(), JsonOptions);
    private static JsonElement Get(JsonElement value, string key) => value.GetProperty(key);
    private static string String(JsonElement value, string key) => Get(value, key).GetString()!;
    private static void Normalize(IAuthoredProject project)
    {
        // Work only on the newly constructed records so normalization never mutates caller data
        // Near-unit rotations pass validation and are stored as unit quaternions for rendering
        void Rotation(double[] rotation)
        {
            var length = QuaternionLength(rotation);
            for (var i = 0; i < 4; i++)
            {
                rotation[i] /= length;
            }
        }

        // V1 owns rotations on its start camera and placed objects only
        if (project is LegacyProject legacy)
        {
            foreach (var scene in legacy.Scenes)
            {
                Rotation(scene.StartCamera.Rotation);
                foreach (var item in scene.Objects)
                {
                    Rotation(item.Transform.Rotation);
                }
            }
        }
        // V2 also stores zone and viewpoint rotations; visit each owner without reordering collections
        else if (project is ContentProject content)
        {
            foreach (var scene in content.Scenes)
            {
                Rotation(scene.StartCamera.Rotation);
                foreach (var item in scene.Objects)
                {
                    Rotation(item.Transform.Rotation);
                }

                foreach (var zone in scene.Zones)
                {
                    Rotation(zone.Transform.Rotation);
                }

                foreach (var viewpoint in scene.Viewpoints)
                {
                    Rotation(viewpoint.Camera.Rotation);
                }
            }
        }
    }
}
