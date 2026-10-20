namespace Spatia.Server.Projects;

public sealed class Project
{
    public const long MaxRevision = 9_007_199_254_740_991;

    public Guid Id { get; set; }

    public Guid OrganizationId { get; set; }

    public bool IsArchived { get; set; }

    public long Revision { get; set; }

    // TODO: Assign SchemaVersion and DocumentJson together from a document accepted by SCRUM-50 validation
    public int SchemaVersion { get; set; }

    public required string DocumentJson { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    // TODO: Have SCRUM-69 clear this slot on metadata revisions so retries cannot acknowledge unrelated edits
    public Guid? LastMutationActorId { get; set; }

    public Guid? LastMutationId { get; set; }

    // TODO: Agree the SCRUM-50 document representation with Part 5 before computing mutation digests
    public byte[]? LastMutationDigest { get; set; }
}
