using Microsoft.AspNetCore.Identity;

namespace Spatia.Server.Accounts;

public sealed class ApplicationUser : IdentityUser<Guid>
{
    public bool IsActive { get; set; } = true;

    public bool MustChangePassword { get; set; } = true;
}
