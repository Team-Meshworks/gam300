using System.Text.Json;

namespace Spatia.Server.Assets;

/// <summary>Reads asset references only from documents already accepted by the shared project validator</summary>
public static class AssetDocumentReferences
{
    public static HashSet<string> Read(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 64 });
        var ids = new HashSet<string>(StringComparer.Ordinal);

        // Collect model and component references together so retention follows every authored asset use
        Visit(document.RootElement, ids);
        return ids;
    }

    private static void Visit(JsonElement node, HashSet<string> ids)
    {

        // Walk ordered scene, object and component collections without changing their authored values
        if (node.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in node.EnumerateArray()) { Visit(item, ids); }
        }
        if (node.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in node.EnumerateObject())
            {

                // Match only the shared format's asset-reference fields; unrelated text is never a retained ID
                if (property.Name is "assetId" or "environmentAssetId" && property.Value.ValueKind == JsonValueKind.String)
                {
                    ids.Add(property.Value.GetString()!);
                }
                else { Visit(property.Value, ids); }
            }
        }
    }
}
