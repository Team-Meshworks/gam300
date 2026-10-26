using Microsoft.AspNetCore.Identity;

namespace Spatia.Server.Accounts;

/// <summary>
/// Stores Identity credentials together with Spatia account access and password-change state
/// </summary>
public sealed class ApplicationUser : IdentityUser<Guid>
{
    /// <summary>
    /// Gets or sets whether the account can establish and retain an authenticated session
    /// </summary>
    public bool IsActive { get; set; } = true;

    /// <summary>
    /// Gets or sets whether the account must change its password before using full account permissions
    /// </summary>
    public bool MustChangePassword { get; set; } = true;
}
