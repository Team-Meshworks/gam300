namespace Spatia.Server.Projects;

public enum ProjectAccessFailure
{
    AuthenticationRequired,
    PasswordChangeRequired,
    NotFound,
    OperationForbidden,
    ProjectReadOnly,
}
