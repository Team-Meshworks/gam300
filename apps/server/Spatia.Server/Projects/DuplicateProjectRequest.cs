using System.Text.Json.Serialization;

namespace Spatia.Server.Projects;

/// <summary>Copies a specific authorized source revision into a separately owned draft</summary>
public sealed record DuplicateProjectRequest
{
    /// <summary>Gets the source revision the caller intends to duplicate</summary>
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public required long ExpectedRevision { get; init; }
    /// <summary>Gets the new project's bounded title</summary>
    public required string Title { get; init; }
}
