namespace Spatia.ProjectFormat;

// A hotspot marker is attached to one placed object in the same scene
// Position is local to that object so moving the object moves the hotspot
public sealed record ProjectHotspot(string Id, string ObjectId, double[] Position);
