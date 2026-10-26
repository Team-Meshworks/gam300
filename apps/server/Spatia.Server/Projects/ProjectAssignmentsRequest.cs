using System.Text.Json.Serialization;

namespace Spatia.Server.Projects;

/// <summary>Replaces a project's complete assignment set at the specified revision</summary>
public sealed record ProjectAssignmentsRequest
{
    /// <summary>Gets the revision being replaced</summary>
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public required long ExpectedRevision { get; init; }
    /// <summary>Gets the same-organization educators who may manage the project</summary>
    public required Guid[] ManagedByUserIds { get; init; }
    /// <summary>Gets the same-organization creators who may edit the project</summary>
    public required Guid[] AssignedCreatorIds { get; init; }
    /// <summary>Gets the subset of assigned creators allowed to publish</summary>
    public required Guid[] CanPublishUserIds { get; init; }
}
