using Microsoft.AspNetCore.Identity;
using Spatia.Server.Accounts;

namespace Spatia.Server.Security;

/// <summary>
/// Adds the application's 128-character password limit to Identity validation
/// </summary>
public sealed class MaximumPasswordLengthValidator : IPasswordValidator<ApplicationUser>
{
    /// <summary>
    /// Rejects passwords longer than 128 characters while leaving other requirements to Identity validators
    /// </summary>
    /// <param name="manager">The Identity manager invoking validation, unused by this length check</param>
    /// <param name="user">The account being validated, unused by this length check</param>
    /// <param name="password">The candidate password, which may be null for other validators to reject</param>
    /// <returns>A failed result for an overlong password, or success when this length limit is satisfied</returns>
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
