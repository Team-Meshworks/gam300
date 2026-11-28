namespace Spatia.Server.Assets;

// Tags are optional so an older client leaves existing tags untouched
public sealed record AssetDetailsRequest(string Name, string Kind, string? Category, AssetReviewRequest Review, string[]? Tags = null);

// Names the single tag to take off an asset
public sealed record AssetTagRemovalRequest(string? Tag);
