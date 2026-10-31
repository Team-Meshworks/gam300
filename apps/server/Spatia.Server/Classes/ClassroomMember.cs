namespace Spatia.Server.Classes;

/// <summary>Retains an educator or student's class membership, including removal history.</summary>
public sealed class ClassroomMember
{
    public Guid ClassroomId { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid UserId { get; set; }
    public Guid RoleId { get; set; }
    public bool IsActive { get; set; } = true;
}
