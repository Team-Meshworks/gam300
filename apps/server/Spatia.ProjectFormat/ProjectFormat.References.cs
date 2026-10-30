using System.Text.Json;

namespace Spatia.ProjectFormat;

// Index the checked document, then resolve hierarchy, asset and interaction targets
public static partial class ProjectFormat
{
    private sealed record Entity(string Kind, string Scene, string Path);
    private static void References(JsonElement root, bool content, IReadOnlyDictionary<string, string> assets)
    {
        // Build the complete index before resolving forward references or navigation targets
        // UUID letter case identifies the same entity; catalogue asset spelling remains exact
        var entities = new Dictionary<string, Entity>(StringComparer.OrdinalIgnoreCase);
        void Entity(string id, string kind, string scene, string path)
        {
            if (id.Length != 36 || !Guid.TryParseExact(id, "D", out _))
            {
                Fail(path, "Expected a UUID");
            }

            // One ID pool includes the project, scenes and every nested entity
            // Store the owning object path for later hierarchy feedback
            if (!entities.TryAdd(id, new(kind, scene, path.EndsWith(".id", StringComparison.Ordinal) ? path[..^3] : path)))
            {
                Fail(path, "Entity ID is already used");
            }
        }

        // Resolve both entity kind and scene ownership; null scene is reserved for explicit destinations
        void Ref(string id, string[] kinds, string? scene, string path)
        {
            if (!entities.TryGetValue(id, out var target) || !kinds.Contains(target.Kind, StringComparer.Ordinal)
                || (scene is not null && !string.Equals(target.Scene, scene, StringComparison.OrdinalIgnoreCase)))
            {
                Fail(path, "Reference must point to an allowed entity in the required scene");
            }
        }

        // The caller supplies the approved catalogue; a file cannot declare its own asset permissions
        void Asset(string id, string kind, string path)
        {
            if (!assets.TryGetValue(id, out var actual) || actual != kind)
            {
                Fail(path, $"Expected an approved {kind} asset");
            }
        }
        void Destination(JsonElement item, string path)
        {
            // The destination viewpoint must belong to the selected scene
            var sceneId = String(item, "sceneId");
            Ref(sceneId, ["scene"], null, $"{path}.sceneId");
            Ref(String(item, "viewpointId"), ["viewpoint"], sceneId, $"{path}.viewpointId");
        }

        // First pass registers identities only, allowing references to entities that occur later in JSON
        Entity(String(root, "projectId"), "project", "", "project.projectId");
        Array(Get(root, "scenes"), "project.scenes", 16, (scene, path) =>
        {
            var sceneId = String(scene, "id");
            Entity(sceneId, "scene", sceneId, $"{path}.id");
            Array(Get(scene, "objects"), $"{path}.objects", 200, (item, path) =>
            {
                Entity(String(item, "id"), "object", sceneId, $"{path}.id");
                if (content)
                {
                    Array(Get(item, "components"), $"{path}.components", 16, (component, path) => Entity(String(component, "id"), String(component, "type"), sceneId, $"{path}.id"));
                }
            });
            if (scene.TryGetProperty("hotspots", out var hotspots))
            {
                Array(hotspots, $"{path}.hotspots", 200, (item, path) => Entity(String(item, "id"), "hotspot", sceneId, $"{path}.id"));
            }
            if (content)
            {
                foreach (var collection in new[] { "groups", "zones", "viewpoints", "rules" })
                {
                    Array(Get(scene, collection), $"{path}.{collection}", 256, (item, path) => Entity(String(item, "id"), collection[..^1], sceneId, $"{path}.id"));
                }
            }
        });

        // Second pass resolves targets against the completed index and approved asset registry
        Array(Get(root, "scenes"), "project.scenes", 16, (scene, path) =>
        {
            var sceneId = String(scene, "id");
            Asset(String(scene, "environmentAssetId"), "environment", $"{path}.environmentAssetId");
            if (content)
            {
                // Validate parent ownership before following chains; only objects and groups can parent
                var parents = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
                foreach (var collection in new[] { "objects", "groups" })
                {
                    Array(Get(scene, collection), $"{path}.{collection}", 200, (item, path) =>
                    {
                        var parent = Get(item, "parentId").GetString();
                        if (parent is not null)
                        {
                            Ref(parent, ["object", "group"], sceneId, $"{path}.parentId");
                        }

                        parents.Add(String(item, "id"), parent);
                    });
                }

                // Reject cycles before hierarchy traversal can loop forever
                foreach (var id in parents.Keys)
                {
                    // A fresh set per starting entity catches self-parenting and longer ancestor loops
                    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    string? current = id;
                    while (current is not null)
                    {
                        if (!seen.Add(current))
                        {
                            Fail($"{entities[id].Path}.parentId", "Hierarchy must not contain a cycle");
                        }

                        current = parents[current];
                    }
                }
            }

            // One interactive marker per object keeps click dispatch unambiguous
            var hotspotObjects = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // Resolve model and media assets separately so an approved asset of the wrong kind is rejected
            Array(Get(scene, "objects"), $"{path}.objects", 200, (item, path) =>
            {
                Asset(String(item, "assetId"), "model", $"{path}.assetId");
                if (content)
                {
                    Array(Get(item, "components"), $"{path}.components", 16, (component, path) =>
                {
                    var type = String(component, "type");
                    if (type is "image" or "audio" or "video")
                    {
                        Asset(String(component, "assetId"), type, $"{path}.assetId");
                    }

                    if (type == "hotspot" && !hotspotObjects.Add(String(item, "id")))
                    {
                        Fail($"{path}.type", "Each object can have at most one hotspot");
                    }

                    if (type == "navigationPoint")
                    {
                        Destination(component, path);
                    }
                });
                }
            });

            // Scene hotspots must attach to an object in the same scene; click rules must target one
            if (scene.TryGetProperty("hotspots", out var hotspots))
            {
                Array(hotspots, $"{path}.hotspots", 200, (item, path) =>
                {
                    var objectId = String(item, "objectId");
                    Ref(objectId, ["object"], sceneId, $"{path}.objectId");
                    if (!hotspotObjects.Add(objectId))
                    {
                        Fail($"{path}.objectId", "Each object can have at most one hotspot");
                    }
                });
            }
            if (scene.TryGetProperty("interactions", out var interactions))
            {
                Array(interactions, $"{path}.interactions", 200, (item, path) =>
                {
                    var trigger = Get(item, "when");
                    if (String(trigger, "type") == "visitor-clicks-hotspot")
                    {
                        Ref(String(trigger, "targetHotspotId"), ["hotspot"], sceneId, $"{path}.when.targetHotspotId");
                    }
                });
            }
            if (!content)
            {
                return;
            }

            // Disabled rules retain valid targets; enabling them must not revive dangling references
            Array(Get(scene, "rules"), $"{path}.rules", 256, (rule, path) =>
            {
                var trigger = Get(rule, "trigger");
                var triggerPath = $"{path}.trigger";
                switch (String(trigger, "type"))
                {
                    case "click": case "gaze": Ref(String(trigger, "targetId"), ["object", "hotspot", "navigationPoint"], sceneId, $"{triggerPath}.targetId"); break;
                    case "zoneEnter": Ref(String(trigger, "zoneId"), ["zone"], sceneId, $"{triggerPath}.zoneId"); break;
                    case "panelClose": Ref(String(trigger, "panelId"), ["text", "image"], sceneId, $"{triggerPath}.panelId"); break;
                }

                // Ordinary actions stay scene-local; navigation checks its chosen scene and viewpoint together
                Array(Get(rule, "actions"), $"{path}.actions", 16, (action, path) =>
                {
                    switch (String(action, "type"))
                    {
                        case "showPanel": Ref(String(action, "panelId"), ["text", "image"], sceneId, $"{path}.panelId"); break;
                        case "playMedia": Ref(String(action, "mediaId"), ["audio", "video"], sceneId, $"{path}.mediaId"); break;
                        case "moveCamera": Ref(String(action, "viewpointId"), ["viewpoint"], sceneId, $"{path}.viewpointId"); break;
                        case "setVisible": Ref(String(action, "objectId"), ["object"], sceneId, $"{path}.objectId"); break;
                        case "navigateScene": Destination(action, path); break;
                    }
                });
            });
        });
    }
}
