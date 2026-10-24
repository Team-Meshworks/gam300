namespace Spatia.Server.Security;

/// <summary>
/// Holds account authority resolved from current database state for an authenticated request
/// </summary>
/// <param name="UserId">The active account's persistent identifier</param>
/// <param name="UserName">The account's current username</param>
/// <param name="Role">The currently validated fixed role name</param>
/// <param name="OrganizationId">The active organization identifier, or null for an administrator</param>
/// <param name="MustChangePassword">Whether the session is restricted pending a password change</param>
public sealed record CurrentAccount(
    Guid UserId,
    string UserName,
    string Role,
    Guid? OrganizationId,
    bool MustChangePassword);
