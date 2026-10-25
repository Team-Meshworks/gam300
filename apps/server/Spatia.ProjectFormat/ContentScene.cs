namespace Spatia.ProjectFormat;

// Several connected physical rooms can share one environment and continuous scene
public sealed record ContentScene(
    string Id,
    string Name,
    string EnvironmentAssetId,
    CameraPose StartCamera,
    ContentObject[] Objects,
    ProjectGroup[] Groups,
    ProjectZone[] Zones,
    ProjectViewpoint[] Viewpoints,
    ProjectRule[] Rules
);
