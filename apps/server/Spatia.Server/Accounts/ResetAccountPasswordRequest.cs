namespace Spatia.Server.Accounts;

/// <summary>
/// Carries a replacement temporary password for an administrator-requested credential reset
/// </summary>
public sealed class ResetAccountPasswordRequest
{
    /// <summary>
    /// Gets the temporary password that the account must replace after sign-in
    /// </summary>
    public required string NewTemporaryPassword { get; init; }
}
