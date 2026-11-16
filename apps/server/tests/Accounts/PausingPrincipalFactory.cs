using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

internal sealed class PausingPrincipalFactory(IUserClaimsPrincipalFactory<ApplicationUser> inner, PrincipalCreationGate gate)
    : IUserClaimsPrincipalFactory<ApplicationUser>
{
    public async Task<ClaimsPrincipal> CreateAsync(ApplicationUser user)
    {
        var principal = await inner.CreateAsync(user);
        await gate.PauseAsync(user.Id);
        return principal;
    }
}
