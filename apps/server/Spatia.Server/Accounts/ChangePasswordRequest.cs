namespace Spatia.Server.Accounts;

/// <summary>
/// Carries the current and replacement credentials for a signed-in account
/// </summary>
public sealed class ChangePasswordRequest
{
    /// <summary>
    /// Gets the current password used to authorize the change
    /// </summary>
    public required string CurrentPassword { get; init; }

    /// <summary>
    /// Gets the replacement password, which must differ from the current password
    /// </summary>
    public required string NewPassword { get; init; }
}
