using System.Text.Json;

namespace Spatia.ProjectFormat;

// Check exact field shapes and local values before resolving entity or asset references
public static partial class ProjectFormat
{
    private static void Fields(JsonElement value, string path, params string[] fields)
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
            if (!fields.Contains(property.Name, StringComparer.Ordinal))
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

        Fields(value, path, ["id", "type", .. extra!]);
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
                // Reject credentials and spellings browsers would clean up before opening a link
                // Preserve the authored URL rather than rewriting it through the URI parser
                var url = Text(parameter, fieldPath, 2048);
                if (!url.StartsWith("https://", StringComparison.Ordinal) || url.Any(character => character <= 32 || character == 127 || character == '\\')
                    || !Uri.TryCreate(url, UriKind.Absolute, out var parsed) || string.IsNullOrEmpty(parsed.Host) || !string.IsNullOrEmpty(parsed.UserInfo))
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
                : ["id", "name", "environmentAssetId", "startCamera", "objects"]);

            // Version 1 retains its released text and spatial limits
            var maxText = content ? 256 : int.MaxValue;
            Text(Get(scene, "id"), $"{path}.id", maxText);
            Text(Get(scene, "name"), $"{path}.name", maxText);
            Text(Get(scene, "environmentAssetId"), $"{path}.environmentAssetId", maxText);
            Pose(Get(scene, "startCamera"), $"{path}.startCamera", true, content);

            // Check the shared spatial fields before reading v2 hierarchy and attached content
            Array(Get(scene, "objects"), $"{path}.objects", 200, (item, path) =>
            {
                Fields(item, path, content ? ["id", "name", "assetId", "transform", "parentId", "visible", "components"] : ["id", "name", "assetId", "transform"]);
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
            });
            if (!content)
            {
                return;
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
