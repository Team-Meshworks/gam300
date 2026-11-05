namespace Spatia.Server.Assets;

/// <summary>Keeps the optional destructive action explicit and separate from ordinary library retirement</summary>
public sealed record AssetAvailabilityRequest(string Action, bool RemoveFromProjects = false);
