namespace Spatia.ProjectFormat;

public sealed record MoveCameraAction(string ViewpointId, double DurationSeconds) : ProjectAction;
