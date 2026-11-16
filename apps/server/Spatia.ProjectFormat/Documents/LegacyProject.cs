namespace Spatia.ProjectFormat;

public sealed record LegacyProject(
    int SchemaVersion,
    string ProjectId,
    string Title,
    LegacyScene[] Scenes
) : IAuthoredProject;
