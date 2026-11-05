namespace Spatia.Server.Assets;

/// <summary>Records an explicit human review without treating validator success as redistribution permission</summary>
public sealed record AssetReviewRequest(string Source, string License, string ReviewNotes);
