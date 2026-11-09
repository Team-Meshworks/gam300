using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Spatia.ProjectFormat;
using Format = Spatia.ProjectFormat.ProjectFormat;

// Read the same cases as the browser suite so the two validators cannot quietly diverge
var fixtures = Path.Combine(AppContext.BaseDirectory, "fixtures");
var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "project-format-cases.json")))!;
var assets = manifest["assets"]!.AsObject().ToDictionary(
    pair => pair.Key,
    pair => pair.Value!.GetValue<string>(),
    StringComparer.Ordinal);

// The cross-runtime runner sends actual writer output through stdin and receives checked JSON
// Keep this mode separate from fixture assertions so neither reader can silently skip the peer's bytes
if (args is ["--exchange"])
{
    // Pipes must use UTF-8 on Windows too, preserving Unicode rather than the console's legacy code page
    Console.InputEncoding = Encoding.UTF8;
    Console.OutputEncoding = new UTF8Encoding(false);

    // Preserve request order so the caller can pair each result with its original or serialized input
    var inputs = JsonSerializer.Deserialize<string[]>(Console.In.ReadToEnd())!;
    var outputs = inputs.Select(input =>
    {
        // Only accepted documents reach the writer; rejection retains its original field path
        var read = Format.Deserialize(input, assets);
        var saved = read.Ok ? Format.Serialize(read.Value, assets) : new FormatResult<string>(null, read.Error);

        // Compare all missing capabilities with the browser for the same validated document
        // An empty supported set exposes every requirement without choosing a player's feature set
        var capabilities = read.Ok
            ? ProjectCapabilities.Missing(read.Value!, new HashSet<string>(StringComparer.Ordinal))
                .Select(issue => new { path = issue.Path, capability = issue.Capability }).ToArray()
            : null;
        return new { ok = saved.Ok, json = saved.Value, path = saved.Error?.Path, capabilities };
    });

    // Emit one response array and stop before the human-readable fixture summary reaches stdout
    Console.WriteLine(JsonSerializer.Serialize(outputs));
    return;
}

var originals = new Dictionary<string, JsonNode>
{
    ["m1"] = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "m1-project.json")))!,
    ["m2"] = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "m2-project.json")))!,
};
var count = 0;
foreach (var test in manifest["cases"]!.AsArray())
{
    // Each case changes a fresh fixture; one rejection must not contaminate later checks
    var input = originals[test!["base"]!.GetValue<string>()].DeepClone();
    foreach (var patch in test["patches"]!.AsArray())
    {
        // Paths mix object keys and array positions to target the exact boundary under test
        var path = patch!["path"]!.AsArray();
        var parent = input;
        foreach (var key in path.Take(path.Count - 1))
        {
            parent = Child(parent, key!)!;
        }

        var last = path[^1]!;
        var remove = patch["remove"]?.GetValue<bool>() ?? false;
        JsonNode? value = patch["value"]?.DeepClone();
        if (patch["repeat"] is { } repeated)
        {
            // Expand limit cases here instead of checking megabytes of repeated data into Git
            var repeatCount = repeated.GetValue<int>();
            if (value is JsonValue scalar && scalar.TryGetValue<string>(out var repeatedText))
            {
                value = JsonValue.Create(string.Concat(Enumerable.Repeat(repeatedText, repeatCount)));
            }
            else
            {
                var array = new JsonArray();
                for (var i = 0; i < repeatCount; i++)
                {
                    array.Add(value?.DeepClone());
                }

                value = array;
            }
        }
        // Apply the requested replacement or removal to the cloned tree without changing the base fixture
        if (parent is JsonArray list)
        {
            var index = last.GetValue<int>();
            if (remove)
            {
                list.RemoveAt(index);
            }
            else
            {
                list[index] = value;
            }
        }
        else
        {
            var key = last.GetValue<string>();
            if (remove)
            {
                parent.AsObject().Remove(key);
            }
            else
            {
                parent[key] = value;
            }
        }
    }

    // Check acceptance first, then require every accepted case to save and reopen successfully
    var name = test["name"]!.GetValue<string>();
    var result = Format.Deserialize(input.ToJsonString(), assets);
    Check(result.Ok == test["valid"]!.GetValue<bool>(), $"{name}: acceptance mismatch at {result.Error?.Path}");

    // Agreement includes the bad field's path so callers can show useful import feedback
    if (!result.Ok)
    {
        Check(result.Error!.Path == test["path"]!.GetValue<string>(),
            $"{name}: wrong rejection path {result.Error.Path}");
    }
    else
    {
        var saved = Format.Serialize(result.Value, assets);
        Check(saved.Ok, $"{name}: serialization failed");
        var reopened = Format.Deserialize(saved.Value!, assets);
        Check(reopened.Ok, $"{name}: reopening failed");

        // Compare all data and array order while allowing quaternion normalization drift
        Equivalent(JsonDocument.Parse(input.ToJsonString()).RootElement, JsonDocument.Parse(saved.Value!).RootElement, name);
    }
    count++;
}

// Raw cases retain malformed syntax and duplicate keys that an object tree would erase
foreach (var test in manifest["rawCases"]!.AsArray())
{
    var result = Format.Deserialize(test!["json"]!.GetValue<string>(), assets);
    Check(result.Ok == test["valid"]!.GetValue<bool>(), $"Raw JSON {test["name"]}: acceptance mismatch");
    if (!result.Ok)
    {
        Check(result.Error!.Path == test["path"]!.GetValue<string>(),
            $"Raw JSON {test["name"]}: rejection path mismatch");
    }

    count++;
}

// Build boundary inputs from the released fixture so size and encoding checks cover a real document
var legacy = originals["m1"].ToJsonString();

// Caller dictionary settings must not turn an unknown asset spelling into an approved one
var caseInsensitiveAssets = new Dictionary<string, string>(assets, StringComparer.OrdinalIgnoreCase);
Check(!Format.Deserialize(legacy.Replace("test-crate-v1", "TEST-CRATE-V1", StringComparison.Ordinal), caseInsensitiveAssets).Ok,
    "asset ID case remains exact regardless of caller comparer");

// Include whitespace in the input budget and check both sides of the exact byte boundary
Check(Format.Deserialize(legacy.PadRight(Format.MaxProjectBytes), assets).Ok, "5 MiB input boundary");
Check(!Format.Deserialize(legacy.PadRight(Format.MaxProjectBytes) + " ", assets).Ok, "5 MiB plus one byte");
Check(!Format.Deserialize("[" + new string('[', 32) + "0" + new string(']', 33), assets).Ok, "depth limit");
Check(!Format.Deserialize(legacy.Replace("{", "{\"schemaVersion\":1,", StringComparison.Ordinal), assets).Ok,
    "duplicate fields");
Check(!Format.Deserialize("{\"schema\\u0056ersion\":1," + legacy[1..], assets).Ok, "escaped duplicate fields");

// Character count alone would accept this file even though its UTF-8 bytes exceed the limit
var wide = legacy.Replace("Crate layout", new string('展', 2 * 1024 * 1024), StringComparison.Ordinal);
Check(wide.Length < Format.MaxProjectBytes && !Format.Deserialize(wide, assets).Ok, "UTF-8 file limit");

// Valid Unicode must also survive without escaping inflation pushing it beyond the file limit
var unicode = legacy.Replace("Crate layout", string.Concat(Enumerable.Repeat("🏺\u2028", 600000)), StringComparison.Ordinal);
var unicodeProject = Format.Deserialize(unicode, assets);
Check(unicodeProject.Ok, "large valid Unicode document");
Check(Format.Serialize(unicodeProject.Value, assets).Value!.Contains("🏺\u2028", StringComparison.Ordinal),
    "Unicode size and content preservation");
Check(!Format.Deserialize(legacy.Replace("Crate layout", "\ud800", StringComparison.Ordinal), assets).Ok,
    "invalid UTF-16 input");

// Typed callers can bypass JSON input, so saving must reject malformed strings too
var legacyModel = (LegacyProject)Format.Deserialize(legacy, assets).Value!;
Check(!Format.Serialize(legacyModel with { Title = "\ud800" }, assets).Ok, "invalid UTF-16 serialization");

// A valid saved document may require features absent from a particular player build
var content = (ContentProject)Format.Deserialize(originals["m2"].ToJsonString(), assets).Value!;
var issues = ProjectCapabilities.Missing(content, new HashSet<string>());
Check(issues.Any(issue => issue.Capability == "trigger:gaze"), "unavailable trigger reported");
var supported = issues.Select(issue => issue.Capability).ToHashSet(StringComparer.Ordinal);
Check(ProjectCapabilities.Missing(content, supported).Count == 0, "fully supported build");
supported.Remove("trigger:gaze");

// Disabling a rule removes its execution requirement without discarding the authored rule
var disabled = content with
{
    Scenes = content.Scenes.Select(scene => scene with
    {
        Rules = scene.Rules.Select(rule => rule.Trigger is GazeTrigger ? rule with { Enabled = false } : rule).ToArray(),
    }).ToArray()
};
Check(ProjectCapabilities.Missing(disabled, supported).Count == 0, "disabled known trigger preserved without blocking");
Check(Format.Serialize(disabled, assets).Value!.Contains("gaze", StringComparison.Ordinal),
    "disabled rule serialization");
Console.WriteLine($"Passed {count} shared format cases, byte/depth/duplicate-key boundaries, full-data round trips and capability checks");

static JsonNode? Child(JsonNode parent, JsonNode key) => parent is JsonArray list ? list[key.GetValue<int>()] : parent[key.GetValue<string>()];
static void Check(bool valid, string name)
{
    // Throwing gives local runs and CI a failing exit code with the offending case name
    if (!valid)
    {
        throw new InvalidOperationException(name);
    }
}
static void Equivalent(JsonElement source, JsonElement result, string path)
{
    // Compare meaning recursively; property order and equivalent JSON escapes are irrelevant
    Check(source.ValueKind == result.ValueKind, $"{path}: changed value kind");
    switch (source.ValueKind)
    {
        // Check both field count and names so round trips cannot quietly discard unknown content
        case JsonValueKind.Object:
            // Empty interaction extensions are omitted to preserve released scene contracts.
            var scene = source.TryGetProperty("environmentAssetId", out _);
            bool Included(JsonProperty property) => !(scene
                && property.Name is "hotspots" or "interactions"
                && property.Value.ValueKind == JsonValueKind.Array
                && property.Value.GetArrayLength() == 0);
            Check(source.EnumerateObject().Count(Included) == result.EnumerateObject().Count(Included),
                $"{path}: lost or added fields");
            foreach (var property in source.EnumerateObject().Where(Included))
            {
                Check(result.TryGetProperty(property.Name, out var found), $"{path}.{property.Name}: missing field");
                Equivalent(property.Value, found, $"{path}.{property.Name}");
            }
            break;
        case JsonValueKind.Array:
            Check(source.GetArrayLength() == result.GetArrayLength(), $"{path}: changed array length");
            if (path.EndsWith(".rotation", StringComparison.Ordinal) && source.GetArrayLength() == 4)
            {
                // Validation normalizes near-unit quaternions without changing their orientation
                var values = source.EnumerateArray().Select(value => value.GetDouble()).ToArray();
                var length = Math.Sqrt(values.Sum(value => value * value));
                for (var i = 0; i < values.Length; i++)
                {
                    Check(Math.Abs(values[i] / length - result[i].GetDouble()) < 1e-12, $"{path}: changed rotation");
                }

                break;
            }

            // Scene, component, rule and action arrays must retain their authored order
            for (var i = 0; i < source.GetArrayLength(); i++)
            {
                Equivalent(source[i], result[i], $"{path}[{i}]");
            }

            break;
        case JsonValueKind.Number:

            // Allow floating-point round-trip noise while still detecting authored value changes
            var a = source.GetDouble();
            var b = result.GetDouble();
            Check(Math.Abs(a - b) <= 1e-12 * Math.Max(1, Math.Abs(a)), $"{path}: changed numeric value");
            break;
        default:
            Check(source.GetRawText() == result.GetRawText() || (source.ValueKind == JsonValueKind.String && source.GetString() == result.GetString()),
                $"{path}: changed value");
            break;
    }
}
