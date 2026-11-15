namespace Spatia.ProjectFormat;

public sealed record NavigateSceneAction(string SceneId, string ViewpointId) : ProjectAction;
