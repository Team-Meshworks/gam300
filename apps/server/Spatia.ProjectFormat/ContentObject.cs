namespace Spatia.ProjectFormat;

// Parents organize objects without changing their world transforms
public sealed record ContentObject(string Id, string Name, string AssetId, SpatialTransform Transform,
    string? ParentId, bool Visible, ContentComponent[] Components);
