namespace Spatia.Server.Accounts;

/// <summary>
/// Carries private credentials for creating the first administrator
/// </summary>
public sealed class BootstrapAdministratorRequest
{
    /// <summary>
    /// Gets the requested administrator username
    /// </summary>
    public required string UserName { get; init; }

    /// <summary>
    /// Gets the temporary password that must be changed after first sign-in
    /// </summary>
    public required string InitialPassword { get; init; }
}
