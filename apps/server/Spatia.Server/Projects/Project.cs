namespace Spatia.Server.Projects;

/// <summary>
/// Stores a project draft, its organization boundary and the latest revision and mutation metadata
/// </summary>
public sealed class Project
{
    /// <summary>
    /// The largest permitted revision within JavaScript's safe integer range
    /// </summary>
    public const long MaxRevision = 9_007_199_254_740_991;

    /// <summary>
    /// Gets or sets the persistent project identifier
    /// </summary>
    public Guid Id { get; set; }

    /// <summary>
    /// Gets or sets the organization that owns the project
    /// </summary>
    public Guid OrganizationId { get; set; }

    /// <summary>
    /// Gets or sets whether the draft is archived and therefore read-only for content writes
    /// </summary>
    public bool IsArchived { get; set; }

    /// <summary>
    /// Gets or sets the current revision, bounded by <see cref="MaxRevision"/>
    /// </summary>
    public long Revision { get; set; }

    /// <summary>
    /// Gets or sets the schema version that must match the stored document
    /// </summary>
    // TODO: Assign SchemaVersion and DocumentJson together from a document accepted by SCRUM-50 validation
    public int SchemaVersion { get; set; }

    /// <summary>
    /// Gets or sets the project JSON stored as PostgreSQL jsonb
    /// </summary>
    public required string DocumentJson { get; set; }

    /// <summary>
    /// Gets or sets the persisted update timestamp for the current draft revision
    /// </summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>
    /// Gets or sets the actor associated with the latest remembered mutation, or null when absent
    /// </summary>
    // TODO: Have SCRUM-69 clear this slot on metadata revisions so retries cannot acknowledge unrelated edits
    public Guid? LastMutationActorId { get; set; }

    /// <summary>
    /// Gets or sets the latest mutation identifier recognized for retry handling, or null when absent
    /// </summary>
    public Guid? LastMutationId { get; set; }

    /// <summary>
    /// Gets or sets the latest mutation's 32-byte server-derived digest, or null when no mutation is remembered
    /// </summary>
    // TODO: Agree the SCRUM-50 document representation with Part 5 before computing mutation digests
    public byte[]? LastMutationDigest { get; set; }
}
