namespace Spatia.Server.Projects;

/// <summary>
/// Selects the permissions and archive restrictions checked when acquiring a project lock
/// </summary>
public enum ProjectLockPurpose
{
    /// <summary>
    /// Requires editing permission on an unarchived project
    /// </summary>
    EditDraft,

    /// <summary>
    /// Requires management permission on an unarchived project
    /// </summary>
    ManageAssignments,

    /// <summary>
    /// Requires management permission and allows either current archive state
    /// </summary>
    ChangeArchiveState,
}
