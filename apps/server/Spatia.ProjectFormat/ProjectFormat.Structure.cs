using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Spatia.ProjectFormat;

// Check exact field shapes and local values before resolving entity or asset references
public static partial class ProjectFormat
{
    private static void Fields(JsonElement value, string path, params string[] fields) =>
        Fields(value, path, fields, []);

    private static void Fields(
        JsonElement value,
        string path,
        string[] fields,
        string[] optional)
    {
        // Check the field set before readers use GetProperty so missing data gets a useful error path
        if (value.ValueKind != JsonValueKind.Object)
        {
            Fail(path, "Expected an object");
        }

        foreach (var field in fields)
        {
            if (!value.TryGetProperty(field, out _))
            {
                Fail($"{path}.{field}", "Required field is missing");
            }
        }

        // Reject misspellings and unsupported fields instead of silently dropping authored data
        foreach (var property in value.EnumerateObject())
        {
            if (!fields.Contains(property.Name, StringComparer.Ordinal)
                && !optional.Contains(property.Name, StringComparer.Ordinal))
            {
                Fail($"{path}.{property.Name}", "Unknown field");
            }
        }
    }

    private static string Text(JsonElement value, string path, int limit = 256)
    {
        // Both runtimes count UTF-16 units; malformed surrogate pairs are never authored text
        if (value.ValueKind != JsonValueKind.String)
        {
            Fail(path, "Expected a string");
        }

        var text = value.GetString()!;
        // PostgreSQL jsonb cannot store NUL; reject it without altering authored text
        if (text.Contains('\0'))
        {
            Fail(path, "Text contains an unsupported NUL character");
        }
        if (text.Length > limit)
        {
            Fail(path, $"Text exceeds {limit} characters");
        }

        return text;
    }

    // Imported flags stay booleans; strings and numbers never acquire truthiness here
    private static void Boolean(JsonElement value, string path)
    {
        if (value.ValueKind is not JsonValueKind.True and not JsonValueKind.False)
        {
            Fail(path, "Expected a boolean");
        }
    }

    // All numeric fields reject non-finite values before applying their inclusive bounds
    private static double Number(JsonElement value, string path, double min, double max)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number) || number < min || number > max)
        {
            Fail(path, "Number is outside the allowed range");
        }

        return value.GetDouble();
    }

    private static void Array(JsonElement value, string path, int max, Action<JsonElement, string> read)
    {
        // Bound the collection before visiting entries and carry each index into error feedback
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > max)
        {
            Fail(path, $"Expected an array with at most {max} entries");
        }

        var index = 0;
        foreach (var item in value.EnumerateArray())
        {
            read(item, $"{path}[{index++}]");
        }
    }

    // Null means scene root; non-null parent strings are resolved after all entities are indexed
    private static void Parent(JsonElement value, string path)
    {
        if (value.ValueKind != JsonValueKind.Null)
        {
            Text(value, path);
        }
    }

    // Check tuple shape first so axis failures can retain their exact indexed path
    private static void Vector(JsonElement value, string path, int count, double min, double max)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != count
            || value.EnumerateArray().Any(entry => entry.ValueKind != JsonValueKind.Number || !entry.TryGetDouble(out var number) || !double.IsFinite(number)))
        {
            Fail(path, $"Expected {count} finite numbers");
        }

        for (var i = 0; i < count; i++)
        {
            Number(value[i], $"{path}[{i}]", min, max);
        }
    }

    private static double QuaternionLength(double[] values)
    {
        // Scale before squaring to avoid overflow or underflow while measuring imported rotations
        var max = values.Max(Math.Abs);
        return max == 0 ? 0 : max * Math.Sqrt(values.Sum(value => (value / max) * (value / max)));
    }

    private static void Pose(JsonElement value, string path, bool camera, bool content)
    {
        // Cameras and objects share position/rotation checks but have different final fields
        Fields(value, path, camera ? ["position", "rotation", "fovDegrees"] : ["position", "rotation", "scale"]);
        var position = Get(value, "position");
        Vector(position, $"{path}.position", 3, -10000, 10000);
        var rotation = Get(value, "rotation");
        if (rotation.ValueKind != JsonValueKind.Array || rotation.GetArrayLength() != 4
            || rotation.EnumerateArray().Any(entry => entry.ValueKind != JsonValueKind.Number || !entry.TryGetDouble(out var number) || !double.IsFinite(number)))
        {
            Fail($"{path}.rotation", "Expected four finite quaternion components");
        }

        // Accept rounding drift only; Normalize later adjusts accepted rotations on a separate model
        var length = QuaternionLength(rotation.EnumerateArray().Select(entry => entry.GetDouble()).ToArray());
        if (!double.IsFinite(length) || Math.Abs(length - 1) > 0.000001)
        {
            Fail($"{path}.rotation", "Expected a unit quaternion");
        }

        if (camera)
        {
            Number(Get(value, "fovDegrees"), $"{path}.fovDegrees", 30, 90);
        }
        else
        {
            // Preserve v1's released scale range while bounding new content documents
            Vector(Get(value, "scale"), $"{path}.scale", 3, double.Epsilon, content ? 10000 : double.MaxValue);
        }
    }

    private static void Component(JsonElement value, string path)
    {
        // Select the content variant first, then check only that variant's fields and parameters
        if (value.ValueKind != JsonValueKind.Object)
        {
            Fail(path, "Expected a component");
        }

        var type = value.TryGetProperty("type", out var tag) && tag.ValueKind == JsonValueKind.String ? tag.GetString() : null;
        var extra = type switch
        {
            "hotspot" => new[] { "label" },
            "text" => ["runs", "caption"],
            "image" => ["assetId", "caption", "alt"],
            "audio" => ["assetId", "caption", "loop", "volume", "mode"],
            "video" => ["assetId", "caption", "loop", "volume"],
            "navigationPoint" => ["label", "sceneId", "viewpointId"],
            _ => null,
        };
        if (extra is null)
        {
            Fail($"{path}.type", "Unsupported component type");
        }

        Fields(value, path, ["id", "type", .. extra!], type == "text" ? ["placement", "background", "color", "fontSize"] : []);
        if (type == "text")
        {
            if (value.TryGetProperty("placement", out var placement)) { Pose(placement, $"{path}.placement", false, true); }
            if (value.TryGetProperty("fontSize", out var fontSize)) { Number(fontSize, $"{path}.fontSize", 12, 96); }
            if (value.TryGetProperty("color", out var textColor))
            {
                var color = Text(textColor, $"{path}.color", 7);
                if (!Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$", RegexOptions.CultureInvariant)) { Fail($"{path}.color", "Choose a text color"); }
            }
            if (value.TryGetProperty("background", out var background))
            {
                var color = Text(background, $"{path}.background", 16);
                if (color != "transparent" && !Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$", RegexOptions.CultureInvariant)) { Fail($"{path}.background", "Choose a background color or transparent"); }
            }
        }
        Text(Get(value, "id"), $"{path}.id");

        // Validate local parameters now; asset approval and entity targets need the complete document
        foreach (var field in extra!)
        {
            if (field == "runs")
            {
                // Apply one panel-wide text budget so many individually valid runs cannot bypass it
                var length = 0;
                Array(Get(value, field), $"{path}.runs", 256, (run, runPath) =>
                {
                    Fields(run, runPath, "text", "marks");
                    length += Text(Get(run, "text"), $"{runPath}.text", 65536).Length;

                    // Marks describe literal text formatting and each supported mark may appear only once
                    var marks = new HashSet<string>(StringComparer.Ordinal);
                    var duplicate = false;
                    Array(Get(run, "marks"), $"{runPath}.marks", 3, (mark, markPath) =>
                    {
                        if (mark.ValueKind != JsonValueKind.String || mark.GetString() is not ("bold" or "italic" or "underline"))
                        {
                            Fail(markPath, "Unsupported text mark");
                        }

                        if (!marks.Add(mark.GetString()!))
                        {
                            duplicate = true;
                        }
                    });
                    if (duplicate)
                    {
                        Fail($"{runPath}.marks", "Text marks must be unique");
                    }
                });
                if (length > 65536)
                {
                    Fail($"{path}.runs", "Formatted text exceeds 65536 characters");
                }
            }
            // Media options remain authored data here; importing never starts playback
            else if (field == "mode")
            {
                var mode = Get(value, field);
                if (mode.ValueKind != JsonValueKind.String || mode.GetString() is not ("spatial" or "global"))
                {
                    Fail($"{path}.mode", "Expected spatial or global audio");
                }
            }
            else if (field == "loop")
            {
                Boolean(Get(value, field), $"{path}.{field}");
            }
            else if (field == "volume")
            {
                Number(Get(value, field), $"{path}.{field}", 0, 1);
            }
            else
            {
                Text(Get(value, field), $"{path}.{field}", field == "text" ? 65536 : field is "caption" or "alt" ? 4096 : 256);
            }
        }
    }

    private static void Variant(JsonElement value, string path, bool trigger)
    {
        // Trigger and action tags choose the wire shape; entity targets are resolved in References
        if (value.ValueKind != JsonValueKind.Object)
        {
            Fail(path, "Expected a rule variant");
        }

        var type = value.TryGetProperty("type", out var tag) && tag.ValueKind == JsonValueKind.String ? tag.GetString() : null;
        string[]? fields = trigger ? type switch
        {
            "click" => ["targetId"],
            "zoneEnter" => ["zoneId"],
            "sceneStart" => [],
            "elapsed" => ["seconds"],
            "gaze" => ["targetId", "seconds"],
            "panelClose" => ["panelId"],
            _ => null,
        } : type switch
        {
            "showPanel" => ["panelId"],
            "playMedia" => ["mediaId"],
            "moveCamera" => ["viewpointId", "durationSeconds"],
            "setVisible" => ["objectId", "visible"],
            "navigateScene" => ["sceneId", "viewpointId"],
            "openLink" => ["url"],
            _ => null,
        };
        if (fields is null)
        {
            Fail($"{path}.type", "Unsupported rule variant");
        }

        Fields(value, path, ["type", .. fields!]);

        // Timing and flags can be checked immediately; referenced IDs are resolved in the second pass
        foreach (var field in fields!)
        {
            var fieldPath = $"{path}.{field}";
            var parameter = Get(value, field);
            if (field == "seconds")
            {
                Number(parameter, fieldPath, type == "gaze" ? 0.1 : 0, type == "gaze" ? 60 : 86400);
            }
            else if (field == "durationSeconds")
            {
                Number(parameter, fieldPath, 0, 60);
            }
            else if (field == "visible")
            {
                Boolean(parameter, fieldPath);
            }
            else if (field == "url")
            {
                // Validate the shared portable authority rules without rewriting the authored URL
                var url = Text(parameter, fieldPath, 2048);
                if (!HttpsLink(url))
                {
                    Fail(fieldPath, "Expected an absolute HTTPS URL without credentials");
                }
            }
            else
            {
                Text(parameter, fieldPath);
            }
        }
    }

    private static bool HttpsLink(string url)
    {
        // Match the browser's raw authority boundary before native parsers can repair or reinterpret it
        if (url.Any(character => character <= 32 || character == 127 || character == '\\'))
        {
            return false;
        }

        // Require an explicit HTTPS host and optional port without credentials or parser-added slashes
        var authority = Regex.Match(url, @"^https://(\[[0-9a-fA-F:.]+\]|[^:/?#@]+)(?::([0-9]{1,5}))?(?=[/?#]|$)");
        if (!authority.Success)
        {
            return false;
        }

        // Decode host escapes only for validation; escaped delimiters must never become URL structure
        var host = Uri.UnescapeDataString(authority.Groups[1].Value);
        var ipv6 = host.StartsWith('[');
        if (!ipv6 && host.Any(character => character <= 32 || "%/\\?#@[]:<>^|".Contains(character) || character == 127))
        {
            return false;
        }

        // Native parsing checks address syntax and port range using the decoded host only
        // Keep the original path, query and fragment intact while validating this temporary candidate
        var candidate = "https://" + host + (authority.Groups[2].Success ? ":" + authority.Groups[2].Value : "") + url[authority.Length..];
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var parsed) || string.IsNullOrEmpty(parsed.Host) || !string.IsNullOrEmpty(parsed.UserInfo))
        {
            return false;
        }

        // Bracketed IPv6 has no DNS labels or legacy IPv4 spelling to check below
        if (ipv6)
        {
            // IPv4-mapped IPv6 still requires canonical decimal octets in browser URLs
            // Inspect the authored suffix before Uri normalizes leading-zero spellings
            if (host.Contains('.'))
            {
                var octets = host[(host.LastIndexOf(':') + 1)..^1].Split('.');
                if (octets.Length != 4 || !octets.All(octet => Regex.IsMatch(octet, @"^(?:0|[1-9][0-9]{0,2})$") && int.Parse(octet) <= 255))
                {
                    return false;
                }
            }
            return parsed.HostNameType == UriHostNameType.IPv6;
        }

        try
        {
            // Both readers bound DNS labels after IDN conversion; preserve Unicode and escaped spelling
            var domain = parsed.IdnHost.EndsWith('.') ? parsed.IdnHost[..^1] : parsed.IdnHost;

            // Uri accepts ASCII xn-- labels without verifying their encoded Unicode characters
            // Decode through IDNA validation before DNS checks so fake labels such as xn--a are rejected
            // Keep the authored URL untouched; this conversion is only an acceptance check
            _ = new IdnMapping().GetUnicode(domain);

            if (domain.Length > 253 || domain.Split('.').Any(label => !Regex.IsMatch(label, @"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$")))
            {
                return false;
            }

            // Numeric suffixes are IPv4 candidates in browsers, never fallback DNS names
            // Require canonical dotted decimal in both readers instead of legacy octal or short forms
            const string numericSuffix = @"(?:^|\.)(?:[0-9]+|0[xX][0-9a-fA-F]*)\.?$";
            if (Regex.IsMatch(host, numericSuffix) || Regex.IsMatch(domain, numericSuffix))
            {
                // Check authored octets because native parsers can normalize short and octal addresses
                var address = host.EndsWith('.') ? host[..^1] : host;
                var parts = address.Split('.');
                return parts.Length == 4 && parts.All(part => Regex.IsMatch(part, @"^(?:0|[1-9][0-9]{0,2})$") && int.Parse(part) <= 255);
            }
            return true;
        }
        catch (ArgumentException)
        {
            // Invalid IDN labels receive the same URL-field feedback as every other rejected host
            return false;
        }
        catch (UriFormatException)
        {
            return false;
        }
    }

    private static void Hotspot(JsonElement value, string path)
    {
        // Scene hotspots attach to one object and store their position in that object's local space
        Fields(value, path, "id", "objectId", "position");
        Text(Get(value, "id"), $"{path}.id");
        Text(Get(value, "objectId"), $"{path}.objectId");
        Vector(Get(value, "position"), $"{path}.position", 3, -10000, 10000);
    }

    private static void InteractionTrigger(JsonElement value, string path)
    {
        // Scene interaction tags differ from content rule triggers and keep their own field sets
        if (value.ValueKind != JsonValueKind.Object)
        {
            Fail(path, "Expected a trigger");
        }

        var type = value.TryGetProperty("type", out var tag) && tag.ValueKind == JsonValueKind.String ? tag.GetString() : null;
        switch (type)
        {
            case "visitor-clicks-hotspot":
                Fields(value, path, "type", "targetHotspotId");
                Text(Get(value, "targetHotspotId"), $"{path}.targetHotspotId");
                break;
            case "scene-starts":
                Fields(value, path, "type");
                break;
            case "time-elapsed":
                Fields(value, path, "type", "seconds");
                Number(Get(value, "seconds"), $"{path}.seconds", double.Epsilon, 86400);
                break;
            default:
                Fail($"{path}.type", "Unsupported trigger type");
                break;
        }
    }

    private static void InteractionAction(JsonElement value, string path)
    {
        // Open links use the shared portable HTTPS rules; audio remains authored text
        if (value.ValueKind != JsonValueKind.Object)
        {
            Fail(path, "Expected an action");
        }

        var type = value.TryGetProperty("type", out var tag) && tag.ValueKind == JsonValueKind.String ? tag.GetString() : null;
        switch (type)
        {
            case "open-link":
                Fields(value, path, "type", "url");
                var link = Text(Get(value, "url"), $"{path}.url", 2048);
                if (!HttpsLink(link))
                {
                    Fail($"{path}.url", "Expected an absolute HTTPS URL without credentials");
                }
                break;
            case "play-audio":
                // Stable media IDs follow the same scene reference checks as other authored targets
                if (value.TryGetProperty("mediaId", out var mediaId))
                {
                    Fields(value, path, "type", "mediaId");
                    Text(mediaId, $"{path}.mediaId");
                }
                else
                {
                    Fields(value, path, "type", "url");
                    Text(Get(value, "url"), $"{path}.url", 2048);
                }
                break;
            case "navigate-scene":
                Fields(value, path, "type", "sceneId");
                Text(Get(value, "sceneId"), $"{path}.sceneId");
                break;
            case "move-to-viewpoint":
                Fields(value, path, "type", "viewpointId");
                Text(Get(value, "viewpointId"), $"{path}.viewpointId");
                break;
            case "print-hi":
                Fields(value, path, "type");
                break;
            default:
                Fail($"{path}.type", "Unsupported action type");
                break;
        }
    }

    private static void Interaction(JsonElement value, string path)
    {
        Fields(value, path, "when", "do");
        InteractionTrigger(Get(value, "when"), $"{path}.when");
        InteractionAction(Get(value, "do"), $"{path}.do");
    }

    private static void Structure(JsonElement root, bool content)
    {
        // Walk the document from the root down before any typed records are constructed
        // The content flag selects v2 additions while preserving the released v1 contract
        Fields(root, "project", "schemaVersion", "projectId", "title", "scenes");
        Text(Get(root, "projectId"), "project.projectId", content ? 256 : int.MaxValue);
        Text(Get(root, "title"), "project.title", content ? 256 : int.MaxValue);

        // V1 keeps its single-scene contract; v2 preserves an ordered list of up to sixteen scenes
        var scenes = Get(root, "scenes");
        if (scenes.ValueKind != JsonValueKind.Array || (content ? scenes.GetArrayLength() is < 1 or > 16 : scenes.GetArrayLength() != 1))
        {
            Fail("project.scenes", "Invalid scene count");
        }

        Array(scenes, "project.scenes", content ? 16 : 1, (scene, path) =>
        {
            Fields(scene, path, content
                ? ["id", "name", "environmentAssetId", "startCamera", "objects", "groups", "zones", "viewpoints", "rules"]
                : ["id", "name", "environmentAssetId", "startCamera", "objects"],
                content ? ["hotspots", "interactions", "audio", "environmentTransform", "environmentVisible"] : ["hotspots", "interactions"]);

            // Version 1 retains its released text and spatial limits
            var maxText = content ? 256 : int.MaxValue;
            Text(Get(scene, "id"), $"{path}.id", maxText);
            Text(Get(scene, "name"), $"{path}.name", maxText);
            var environment = Get(scene, "environmentAssetId");
            if (!content || environment.ValueKind != JsonValueKind.Null)
            {
                Text(environment, $"{path}.environmentAssetId", maxText);
            }
            Pose(Get(scene, "startCamera"), $"{path}.startCamera", true, content);

            // Check the shared spatial fields before reading v2 hierarchy and attached content
            Array(Get(scene, "objects"), $"{path}.objects", 200, (item, path) =>
            {
                Fields(item, path, content ? ["id", "name", "assetId", "transform", "parentId", "visible", "components"] : ["id", "name", "assetId", "transform"], content ? ["appearance"] : []);
                Text(Get(item, "id"), $"{path}.id", maxText);
                Text(Get(item, "name"), $"{path}.name", maxText);
                Text(Get(item, "assetId"), $"{path}.assetId", maxText);
                Pose(Get(item, "transform"), $"{path}.transform", false, content);
                if (!content)
                {
                    return;
                }

                Parent(Get(item, "parentId"), $"{path}.parentId");
                Boolean(Get(item, "visible"), $"{path}.visible");
                Array(Get(item, "components"), $"{path}.components", 16, Component);
                if (item.TryGetProperty("appearance", out var appearance))
                {
                    Fields(appearance, $"{path}.appearance", "color", "material");
                    var color = Text(Get(appearance, "color"), $"{path}.appearance.color", 7);
                    if (!Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$")) { Fail($"{path}.appearance.color", "Choose a six-digit colour"); }
                    var material = Text(Get(appearance, "material"), $"{path}.appearance.material");
                    if (material is not ("plain" or "wood" or "glass" or "leather" or "marble" or "tile" or "concrete" or "ceramic"))
                    { Fail($"{path}.appearance.material", "Choose a supported material"); }
                }
            });

            // Scene hotspots and interactions are shared by both released formats and default to empty
            if (scene.TryGetProperty("hotspots", out var hotspots))
            {
                Array(hotspots, $"{path}.hotspots", 200, Hotspot);
            }
            if (scene.TryGetProperty("interactions", out var interactions))
            {
                Array(interactions, $"{path}.interactions", 200, Interaction);
            }
            if (!content)
            {
                return;
            }

            if (scene.TryGetProperty("environmentVisible", out var environmentVisible))
            { Boolean(environmentVisible, $"{path}.environmentVisible"); }
            if (scene.TryGetProperty("environmentTransform", out var environmentTransform))
            {
                Pose(environmentTransform, $"{path}.environmentTransform", false, true);
            }
            // Only bounded global audio can live at scene level; other content stays attached to objects
            if (scene.TryGetProperty("audio", out var sceneAudio))
            {
                Array(sceneAudio, $"{path}.audio", 64, (item, audioPath) =>
                {
                    Component(item, audioPath);
                    if (String(item, "type") != "audio" || String(item, "mode") != "global")
                    { Fail(audioPath, "Scene audio must be global audio"); }
                });
            }
            // Groups carry hierarchy only; zones and viewpoints own their separate spatial data
            Array(Get(scene, "groups"), $"{path}.groups", 200, (item, path) =>
            {
                Fields(item, path, "id", "name", "parentId");
                Text(Get(item, "id"), $"{path}.id"); Text(Get(item, "name"), $"{path}.name"); Parent(Get(item, "parentId"), $"{path}.parentId");
            });
            Array(Get(scene, "zones"), $"{path}.zones", 64, (item, path) =>
            {
                Fields(item, path, "id", "name", "transform");
                Text(Get(item, "id"), $"{path}.id"); Text(Get(item, "name"), $"{path}.name"); Pose(Get(item, "transform"), $"{path}.transform", false, true);
            });
            Array(Get(scene, "viewpoints"), $"{path}.viewpoints", 64, (item, path) =>
            {
                Fields(item, path, "id", "name", "camera");
                Text(Get(item, "id"), $"{path}.id"); Text(Get(item, "name"), $"{path}.name"); Pose(Get(item, "camera"), $"{path}.camera", true, true);
            });

            // Keep action order and validate disabled rules too so they remain safe to enable later
            Array(Get(scene, "rules"), $"{path}.rules", 256, (item, path) =>
            {
                Fields(item, path, "id", "enabled", "trigger", "actions");
                Text(Get(item, "id"), $"{path}.id"); Boolean(Get(item, "enabled"), $"{path}.enabled");
                Variant(Get(item, "trigger"), $"{path}.trigger", true);
                Array(Get(item, "actions"), $"{path}.actions", 16, (action, path) => Variant(action, path, false));
                if (Get(item, "actions").GetArrayLength() == 0)
                {
                    Fail($"{path}.actions", "A rule needs at least one action");
                }
            });
        });
    }
}
