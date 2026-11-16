namespace Spatia.ProjectFormat;

// Box scale gives its full dimensions; runtime occupancy stays outside this record
public sealed record ProjectZone(string Id, string Name, SpatialTransform Transform);
