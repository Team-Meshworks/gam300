namespace Spatia.ProjectFormat;

public sealed record NavigationPointComponent(
    string Id,
    string Label,
    string SceneId,
    string ViewpointId) : ContentComponent(Id
);
