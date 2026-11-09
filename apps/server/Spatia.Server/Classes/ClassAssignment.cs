namespace Spatia.Server.Classes;

/// <summary>Stores assignment metadata and its original bounded creation request.</summary>
public sealed class ClassAssignment
{
    public const long MinimumUnixSeconds = -62_135_596_800;
    public const long MaximumUnixSeconds = 253_402_300_799;

    public Guid Id { get; set; }
    public Guid ClassroomId { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid CreatedByUserId { get; set; }
    public Guid SourceProjectId { get; set; }
    public long SourceRevision { get; set; }
    public long DueAtUnixSeconds { get; set; }
    public required string Title { get; set; }
    public required string Description { get; set; }
    public required string Instructions { get; set; }
    public required byte[] RequestDigest { get; set; }
    public long Revision { get; set; }
    public Guid? LastEditId { get; set; }
    public Guid? LastEditActorId { get; set; }
    public byte[]? LastEditDigest { get; set; }
}
