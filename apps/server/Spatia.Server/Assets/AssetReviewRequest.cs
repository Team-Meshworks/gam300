namespace Spatia.Server.Assets;

/// <summary>Records an explicit administrator approval with optional supporting details</summary>
public sealed record AssetReviewRequest(string? Source = null, string? License = null, string? ReviewNotes = null);
