namespace Spatia.Server.Accounts;

public sealed record SessionResponse(
    Guid UserId,
    string DisplayName,
    string Role,
    Guid? OrgId,
    bool MustChangePassword);
