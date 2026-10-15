namespace Spatia.Server.Accounts;

public sealed record ProvisionedAccount(
    Guid UserId,
    string UserName,
    string Role,
    Guid? OrgId,
    bool IsActive,
    bool MustChangePassword);
