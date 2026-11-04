namespace Spatia.Server.Accounts;

/// <summary>Overrides only supplied account fields; organization membership cannot be transferred.</summary>
public sealed class UpdateAccountRequest
{
    /// <summary>Gets the replacement person's name.</summary>
    public string? DisplayName { get; init; }
    /// <summary>Gets the replacement sign-in username.</summary>
    public string? UserName { get; init; }
    /// <summary>Gets the replacement Creator or Educator role.</summary>
    public string? Role { get; init; }
    /// <summary>Gets a replacement temporary password, never returned by the server.</summary>
    public string? NewTemporaryPassword { get; init; }
}
