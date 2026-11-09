using System.Text;
using System.Text.Json.Nodes;

namespace Spatia.Server.Tests;

internal static class ProjectTestDocuments
{
    public static string Create(Guid id, string title, int version = 1)
    {
        var document = JsonNode.Parse(File.ReadAllText(System.IO.Path.Combine(AppContext.BaseDirectory, "fixtures", $"m{version}-project.json")))!;
        document["projectId"] = id.ToString("D").ToUpperInvariant();
        document["title"] = title;
        if (version == 2)
        {
            // Fixture-only media is not in the real catalogue; retain every other supported field and rule
            foreach (var scene in document["scenes"]!.AsArray())
            {
                foreach (var item in scene!["objects"]!.AsArray())
                {
                    var components = item!["components"]!.AsArray();
                    foreach (var component in components.Where(value => value!["type"]!.GetValue<string>() is "image" or "audio" or "video").ToArray())
                    {
                        components.Remove(component);
                    }
                }
                var rules = scene["rules"]!.AsArray();
                foreach (var rule in rules.ToArray())
                {
                    var actions = rule!["actions"]!.AsArray();
                    foreach (var action in actions.Where(value => value!["type"]!.GetValue<string>() == "playMedia"
                        || value["panelId"]?.GetValue<string>() == "00000066-0000-4000-8000-000000000000").ToArray())
                    {
                        actions.Remove(action);
                    }
                    if (actions.Count == 0)
                    {
                        rules.Remove(rule);
                    }
                }
            }
        }
        // Match the canonical wire shape while leaving every authored collection intact.
        // Empty extensions are optional; writers omit them for released-reader compatibility.
        foreach (var scene in document["scenes"]!.AsArray())
        {
            foreach (var name in new[] { "hotspots", "interactions" })
            {
                if (scene![name] is JsonArray { Count: 0 })
                {
                    scene.AsObject().Remove(name);
                }
            }
        }
        return document.ToJsonString();
    }

    public static void PadTitleToBytes(JsonNode document, int bytes)
    {
        // Budget the exact representation that will be uploaded, not a separately serialized copy.
        var padding = bytes - Encoding.UTF8.GetByteCount(document.ToJsonString());
        if (padding < 0) { throw new ArgumentOutOfRangeException(nameof(bytes)); }
        document["title"] = document["title"]!.GetValue<string>() + new string('x', padding);
    }
}
