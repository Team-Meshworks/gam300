namespace Spatia.Server.Projects;

/// <summary>
/// Stores an account's assigned editing, management and publication permissions for a project
/// </summary>
public sealed class ProjectAssignment
{
    /// <summary>
    /// Gets or sets the project receiving the assignment
    /// </summary>
    public Guid ProjectId { get; set; }

    /// <summary>
    /// Gets or sets the account receiving the project permissions
    /// </summary>
    public Guid UserId { get; set; }

    /// <summary>
    /// Gets or sets the assigned editing permission, subject to current account and archive checks
    /// </summary>
    public bool CanEdit { get; set; }

    /// <summary>
    /// Gets or sets the assigned permission to manage project access and archive state
    /// </summary>
    public bool CanManage { get; set; }

    /// <summary>
    /// Gets or sets the assigned publication permission, subject to current account and archive checks
    /// </summary>
    public bool CanPublish { get; set; }
}
