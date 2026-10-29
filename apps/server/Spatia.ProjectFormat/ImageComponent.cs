namespace Spatia.ProjectFormat;

public sealed record ImageComponent(string Id, string AssetId, string Caption, string Alt) : ContentComponent(Id);
