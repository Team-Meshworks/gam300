namespace Spatia.Server.Projects;

/// <summary>Public metadata acknowledging a committed project lifecycle operation</summary>
public sealed record ProjectMetadata(Guid ProjectId, long Revision, DateTimeOffset UpdatedAt, bool Archived);
