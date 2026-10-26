namespace Spatia.ProjectFormat;

public sealed record AudioComponent(
    string Id,
    string AssetId,
    string Caption,
    bool Loop,
    double Volume,
    AudioMode Mode) : ContentComponent(Id
);
