namespace Spatia.ProjectFormat;

public sealed record ContentProject(
    int SchemaVersion,
    string ProjectId,
    string Title,
    ContentScene[] Scenes
) : IAuthoredProject;
