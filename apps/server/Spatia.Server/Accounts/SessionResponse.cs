namespace Spatia.Server.Accounts;

/// <summary>
/// Exposes the current authenticated account's display details and authority
/// </summary>
/// <param name="UserId">The current account's persistent identifier</param>
/// <param name="DisplayName">The account username used as its display name</param>
/// <param name="Role">The currently validated fixed role name</param>
/// <param name="OrgId">The organization identifier, or null for an administrator</param>
/// <param name="MustChangePassword">Whether a password change is required before full account access</param>
public sealed record SessionResponse(
    Guid UserId,
    string DisplayName,
    string Role,
    Guid? OrgId,
    bool MustChangePassword);
