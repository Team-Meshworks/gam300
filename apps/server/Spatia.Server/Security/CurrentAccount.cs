namespace Spatia.Server.Security;

public sealed record CurrentAccount(
    Guid UserId,
    string UserName,
    string Role,
    Guid? OrganizationId,
    bool MustChangePassword);
