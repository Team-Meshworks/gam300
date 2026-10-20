namespace Spatia.Server.Accounts;

public sealed class BootstrapAdministratorRequest
{
    public required string UserName { get; init; }

    public required string InitialPassword { get; init; }
}
