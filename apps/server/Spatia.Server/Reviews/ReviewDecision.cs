namespace Spatia.Server.Reviews;

/// <summary>Retains one educator decision without changing the submitted evidence.</summary>
public sealed class ReviewDecision
{
    public const string Approved = "approved";
    public const string Returned = "returned";
    public const string Revoked = "revoked";

    public Guid Id { get; init; }
    public Guid SubmissionId { get; init; }
    public Guid EducatorId { get; init; }
    public long Sequence { get; init; }
    public required string Outcome { get; init; }
    public required string Feedback { get; init; }
    public required byte[] RequestDigest { get; init; }
    public DateTimeOffset DecidedAt { get; private set; }
}
