namespace Spatia.Server.Projects;

/// <summary>
/// Exposes bounded project-list metadata and current public visibility without document bodies or mutation state
/// </summary>
public sealed record ProjectSummary(
    Guid ProjectId, string Title, long Revision, DateTimeOffset UpdatedAt, bool Archived, ProjectPermissions Permissions,
    string OrganizationName, bool IsPublic);
