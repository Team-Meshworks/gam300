namespace Spatia.Server.Assets;

public sealed record AssetDetailsRequest(string Name, string Kind, string? Category, AssetReviewRequest Review);
