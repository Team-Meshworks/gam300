namespace Spatia.Server.Assets;

// Tags are optional so an older client, or an edit that leaves tags alone, keeps the current tags.
// Expected is the details the editor opened with; when present, a save over newer changes is rejected.
public sealed record AssetDetailsRequest(string Name, string Kind, string? Category, AssetReviewRequest Review, string[]? Tags = null,
    AssetDetailsSnapshot? Expected = null);

// What the editing administrator last saw for the fields a details save writes
public sealed record AssetDetailsSnapshot(string? Name, string? Category, AssetReviewRequest? Review, string[]? Tags);

// Names the single tag to take off an asset
public sealed record AssetTagRemovalRequest(string? Tag);
