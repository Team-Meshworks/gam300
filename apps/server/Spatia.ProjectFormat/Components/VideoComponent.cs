namespace Spatia.ProjectFormat;

public sealed record VideoComponent(
    string Id,
    string AssetId,
    string Caption,
    bool Loop,
    double Volume) : ContentComponent(Id
);
