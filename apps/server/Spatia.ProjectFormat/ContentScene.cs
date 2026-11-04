using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

// Several connected physical rooms can share one environment and continuous scene
public sealed record ContentScene(
    string Id,
    string Name,
    string EnvironmentAssetId,
    CameraPose StartCamera,
    ContentObject[] Objects,
    ProjectHotspot[] Hotspots,
    Interaction[] Interactions,
    ProjectGroup[] Groups,
    ProjectZone[] Zones,
    ProjectViewpoint[] Viewpoints,
    ProjectRule[] Rules,
    // Root audio and room state remain optional so existing documents keep their original shape
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ContentComponent[]? Audio = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SpatialTransform? EnvironmentTransform = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? EnvironmentVisible = null
);
