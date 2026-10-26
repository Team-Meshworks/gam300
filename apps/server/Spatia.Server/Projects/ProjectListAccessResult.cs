namespace Spatia.Server.Projects;

/// <summary>
/// Contains a private authorized page or an access failure; never serialize these snapshots to clients
/// </summary>
public sealed record ProjectListAccessResult(
    IReadOnlyList<ProjectAccessSnapshot> Projects,
    Guid? NextCursor,
    ProjectAccessFailure? Failure);
