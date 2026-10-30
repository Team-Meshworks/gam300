namespace Spatia.Server.Accounts;

/// <summary>
/// Carries credentials submitted to establish an account session
/// </summary>
public sealed class LoginRequest
{
    /// <summary>
    /// Gets the account username to look up
    /// </summary>
    public required string UserName { get; init; }

    /// <summary>
    /// Gets the password to verify against the stored credential
    /// </summary>
    public required string Password { get; init; }
}
