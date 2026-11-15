namespace Spatia.Server.Projects;

/// <summary>
/// Confirms the durable revision associated with a completed save or recognized retry
/// </summary>
/// <param name="ProjectId">The saved project's identifier</param>
/// <param name="Revision">The persisted revision acknowledged by the save</param>
/// <param name="ClientMutationId">The client mutation identifier acknowledged by the save</param>
/// <param name="SavedAt">The persisted update timestamp, retained for an idempotent retry</param>
public sealed record ProjectSaveAcknowledgement(
    Guid ProjectId,
    long Revision,
    Guid ClientMutationId,
    DateTimeOffset SavedAt);
