namespace Spatia.Server.Projects;

/// <summary>
/// Identifies why a project access operation was denied
/// </summary>
public enum ProjectAccessFailure
{
    /// <summary>
    /// The request has no current valid authenticated session
    /// </summary>
    AuthenticationRequired,

    /// <summary>
    /// The account must change its password before accessing projects
    /// </summary>
    PasswordChangeRequired,

    /// <summary>
    /// The project is missing or hidden from the current account
    /// </summary>
    NotFound,

    /// <summary>
    /// The current account lacks permission for the requested project operation
    /// </summary>
    OperationForbidden,

    /// <summary>
    /// The project's archived state prevents the requested operation
    /// </summary>
    ProjectReadOnly,
}
