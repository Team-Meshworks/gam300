namespace Spatia.Server.Accounts;

/// <summary>
/// Describes a newly provisioned account without exposing its credentials
/// </summary>
/// <param name="UserId">The account's persistent identifier</param>
/// <param name="UserName">The account's sign-in username</param>
/// <param name="Role">The assigned fixed role name</param>
/// <param name="OrgId">The organization identifier, or null for an administrator</param>
/// <param name="IsActive">Whether the account is enabled</param>
/// <param name="MustChangePassword">Whether a password change is required before full account access</param>
public sealed record ProvisionedAccount(
    Guid UserId,
    string UserName,
    string Role,
    Guid? OrgId,
    bool IsActive,
    bool MustChangePassword);
