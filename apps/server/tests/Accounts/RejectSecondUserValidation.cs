using Microsoft.AspNetCore.Identity;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

internal sealed class RejectSecondUserValidation : IUserValidator<ApplicationUser>
{
    private int _validations;

    public Task<IdentityResult> ValidateAsync(UserManager<ApplicationUser> manager, ApplicationUser user)
        => Task.FromResult(user.UserName == "identity-rollback" && Interlocked.Increment(ref _validations) == 2
            ? IdentityResult.Failed(new IdentityError { Code = "SyntheticRejection", Description = HttpsApplicationFixture.SecretSentinel })
            : IdentityResult.Success);
}
