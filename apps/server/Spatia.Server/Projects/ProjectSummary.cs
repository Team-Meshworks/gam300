namespace Spatia.Server.Projects;

/// <summary>
/// Exposes bounded project-list metadata without document bodies, ownership or mutation state
/// </summary>
public sealed record ProjectSummary(
    Guid ProjectId, string Title, long Revision, DateTimeOffset UpdatedAt, bool Archived, ProjectPermissions Permissions);
