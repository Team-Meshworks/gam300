namespace Spatia.Server.Projects;

public sealed record ProjectSaveAcknowledgement(
    Guid ProjectId,
    long Revision,
    Guid ClientMutationId,
    DateTimeOffset SavedAt);
