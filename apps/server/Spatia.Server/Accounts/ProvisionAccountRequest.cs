namespace Spatia.Server.Accounts;

public sealed class ProvisionAccountRequest
{
    public required string UserName { get; init; }

    public required string InitialPassword { get; init; }

    public required Guid? OrgId { get; init; }

    public required string Role { get; init; }
}
