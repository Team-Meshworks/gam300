namespace Spatia.ProjectFormat;

public sealed record LegacyScene(
    string Id,
    string Name,
    string EnvironmentAssetId,
    CameraPose StartCamera,
    LegacyObject[] Objects
);
