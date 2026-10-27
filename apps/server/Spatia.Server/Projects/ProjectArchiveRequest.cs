using System.Text.Json.Serialization;

namespace Spatia.Server.Projects;

/// <summary>Changes the project's archive state at the specified revision</summary>
public sealed record ProjectArchiveRequest
{
    /// <summary>Gets the revision being replaced</summary>
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public required long ExpectedRevision { get; init; }
    /// <summary>Gets whether the project should become read-only or reopen</summary>
    public required bool Archived { get; init; }
}
