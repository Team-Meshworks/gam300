using Spatia.Server.Accounts;

namespace Spatia.Server.Classes;

/// <summary>Maps one enrolled student to the independent draft created for an assignment.</summary>
public sealed class ClassAssignmentStudent
{
    public Guid AssignmentId { get; set; }
    public Guid ClassroomId { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid StudentId { get; set; }
    public Guid RoleId { get; set; } = ApplicationRoles.CreatorId;
    public Guid ProjectId { get; set; }
    public bool IsActive { get; set; } = true;
    public bool OriginallyAssigned { get; set; } = true;
}
