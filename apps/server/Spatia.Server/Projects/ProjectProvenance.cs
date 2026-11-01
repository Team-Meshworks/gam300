namespace Spatia.Server.Projects;

/// <summary>Stores a server-established ordinary or class origin; no record means unverified origin.</summary>
public sealed class ProjectProvenance
{
    public const string Ordinary = "ordinary";
    public const string Class = "class";

    public Guid ProjectId { get; set; }
    public Guid OrganizationId { get; set; }
    public required string Kind { get; set; }
    public Guid? ClassAssignmentId { get; set; }
    public Guid? StudentId { get; set; }
}
