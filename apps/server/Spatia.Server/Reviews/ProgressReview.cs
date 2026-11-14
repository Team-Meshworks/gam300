namespace Spatia.Server.Reviews;

/// <summary>A private educator comment on a student's saved project revision.</summary>
public sealed class ProgressReview
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Guid EducatorId { get; set; }
    public long Revision { get; set; }
    public string Feedback { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
}
