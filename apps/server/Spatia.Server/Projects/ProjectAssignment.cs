namespace Spatia.Server.Projects;

public sealed class ProjectAssignment
{
    public Guid ProjectId { get; set; }

    public Guid UserId { get; set; }

    public bool CanEdit { get; set; }

    public bool CanManage { get; set; }

    public bool CanPublish { get; set; }
}
