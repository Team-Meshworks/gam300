namespace Spatia.Server.Reviews;

/// <summary>Stores the validated document and immutable asset identities submitted for one draft revision.</summary>
public sealed class ReviewSubmission
{
    public Guid Id { get; init; }
    public Guid ProjectId { get; init; }
    public Guid StudentId { get; init; }
    public long Sequence { get; init; }
    public long SourceRevision { get; init; }
    public long DueAtUnixSeconds { get; init; }
    public int SchemaVersion { get; init; }
    public bool CompletionConfirmed { get; init; }
    public required string DocumentJson { get; init; }
    public required string AssetReferencesJson { get; init; }
    public required byte[] RequestDigest { get; init; }
    public DateTimeOffset SubmittedAt { get; private set; }
}
