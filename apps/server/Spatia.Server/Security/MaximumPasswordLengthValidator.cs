using Microsoft.AspNetCore.Identity;
using Spatia.Server.Accounts;

namespace Spatia.Server.Security;

public sealed class MaximumPasswordLengthValidator : IPasswordValidator<ApplicationUser>
{
    public Task<IdentityResult> ValidateAsync(UserManager<ApplicationUser> manager, ApplicationUser user, string? password)
    {
        return Task.FromResult(password?.Length > 128
            ? IdentityResult.Failed(new IdentityError
            {
                Code = "PasswordTooLong",
                Description = "Passwords must contain at most 128 characters.",
            })
            : IdentityResult.Success);
    }
}
