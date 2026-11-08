using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Spatia.Server.Assets;

// Remove only authored references and the entities that depend on them
internal static class AssetDocumentRemoval
{
    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    internal static string Remove(string json, string assetId)
    {
        var root = JsonNode.Parse(json)!.AsObject();
        var scenes = root["scenes"]!.AsArray();
        // A released v1 scene requires a room, so upgrade only when removal needs an empty environment
        if (root["schemaVersion"]!.GetValue<int>() == 1
            && scenes.Any(scene => scene!["environmentAssetId"]?.GetValue<string>() == assetId))
        {
            root["schemaVersion"] = 2;
            // Keep the released document valid when the required empty room moves it to v2
            // Only names and scale have narrower limits; identities and references stay untouched
            LimitName(root, "title");
            foreach (var scene in scenes)
            {
                LimitName(scene!, "name");
                foreach (var field in new[] { "groups", "zones", "viewpoints", "rules" }) { scene![field] = new JsonArray(); }
                foreach (var item in scene!["objects"]!.AsArray())
                {
                    LimitName(item!, "name");
                    var scale = item!["transform"]!["scale"]!.AsArray();
                    for (var axis = 0; axis < scale.Count; axis++)
                    { scale[axis] = Math.Min(scale[axis]!.GetValue<double>(), 10000); }
                    item["parentId"] = null;
                    item["visible"] = true;
                    item["components"] = new JsonArray();
                }
            }
        }
        foreach (var scene in scenes)
        {
            if (scene!["environmentAssetId"]?.GetValue<string>() == assetId)
            {
                scene["environmentAssetId"] = null;
                scene.AsObject().Remove("environmentTransform");
                scene.AsObject().Remove("environmentVisible");
            }
            var removed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var objects = scene["objects"]!.AsArray();
            foreach (var item in objects.Where(item => item!["assetId"]!.GetValue<string>() == assetId))
            { removed.Add(item!["id"]!.GetValue<string>()); }

            // A model's explicit hierarchy descendants leave with their parent
            var hierarchy = objects.Concat(scene["groups"]?.AsArray() ?? []).ToArray();
            bool changed;
            do
            {
                changed = false;
                foreach (var item in hierarchy)
                {
                    if (item!["parentId"] is { } parent && removed.Contains(parent.GetValue<string>()))
                    { changed |= removed.Add(item["id"]!.GetValue<string>()); }
                }
            } while (changed);
            foreach (var item in objects.ToArray())
            {
                if (removed.Contains(item!["id"]!.GetValue<string>()))
                {
                    foreach (var component in item["components"]?.AsArray() ?? [])
                    { removed.Add(component!["id"]!.GetValue<string>()); }
                    objects.Remove(item);
                }
                else { RemoveAssets(item["components"] as JsonArray, assetId, removed); }
            }
            RemoveAssets(scene["audio"] as JsonArray, assetId, removed);
            foreach (var field in new[] { "groups", "hotspots" })
            {
                if (scene[field] is not JsonArray entries) { continue; }
                foreach (var item in entries.ToArray())
                {
                    if (removed.Contains(item!["id"]!.GetValue<string>()) || ReferencesRemoved(item, removed))
                    {
                        removed.Add(item["id"]!.GetValue<string>());
                        entries.Remove(item);
                    }
                }
            }
            if (scene["rules"] is JsonArray rules)
            {
                foreach (var rule in rules.ToArray())
                {
                    var actions = rule!["actions"]!.AsArray();
                    foreach (var action in actions.Where(action => ReferencesRemoved(action!, removed)).ToArray()) { actions.Remove(action); }
                    if (ReferencesRemoved(rule["trigger"]!, removed) || actions.Count == 0) { rules.Remove(rule); }
                }
            }
            if (scene["interactions"] is JsonArray interactions)
            {
                foreach (var item in interactions.Where(item => ReferencesRemoved(item!, removed)).ToArray()) { interactions.Remove(item); }
            }
        }
        return root.ToJsonString(JsonOptions);
    }

    private static void LimitName(JsonNode node, string field)
    {
        var text = node[field]!.GetValue<string>();
        if (text.Length <= 256) { return; }
        // Leave a complete Unicode character at the v2 boundary
        node[field] = text[..(char.IsHighSurrogate(text[255]) ? 255 : 256)];
    }

    private static void RemoveAssets(JsonArray? components, string assetId, HashSet<string> removed)
    {
        if (components is null) { return; }
        foreach (var component in components.Where(item => item?["assetId"]?.GetValue<string>() == assetId).ToArray())
        {
            removed.Add(component!["id"]!.GetValue<string>());
            components.Remove(component);
        }
    }

    private static bool ReferencesRemoved(JsonNode node, HashSet<string> removed) => node switch
    {
        JsonObject item => item.Any(property =>
            property.Key is "parentId" or "objectId" or "targetId" or "targetHotspotId" or "panelId" or "mediaId"
                && property.Value is JsonValue value && value.TryGetValue<string>(out var id) && removed.Contains(id)
            || property.Value is JsonObject or JsonArray && ReferencesRemoved(property.Value, removed)),
        JsonArray items => items.Any(item => item is not null && ReferencesRemoved(item, removed)),
        _ => false
    };
}
