using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class BundledAssetAccessTests
{
    [Test]
    [Arguments("anonymous", 401)]
    [Arguments(ApplicationRoles.Administrator, 204)]
    [Arguments(ApplicationRoles.Educator, 204)]
    [Arguments(ApplicationRoles.Creator, 204)]
    [Arguments("forced", 403)]
    [Arguments("disabled", 401)]
    [Arguments("expired", 401)]
    public async Task CatalogueGate_RequiresCurrentFullSession(string actor, int expected)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        if (actor != "anonymous")
        {
            var role = actor is "forced" or "disabled" or "expired" ? ApplicationRoles.Creator : actor;
            var id = await fixture.CreateAccountAsync(role, forced: actor == "forced");
            await fixture.SignInAsync(id);
            if (actor == "disabled")
            {
                await using var scope = fixture.Database.Services.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(user => user.Id == id)
                    .ExecuteUpdateAsync(setters => setters.SetProperty(user => user.IsActive, false));
            }
            if (actor == "expired")
            {
                fixture.Clock.Set(fixture.Clock.GetUtcNow().AddHours(9));
            }
        }
        using var response = await fixture.Client.GetAsync("/api/auth/asset-access");
        await Assert.That((int)response.StatusCode).IsEqualTo(expected);
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
        await Assert.That(response.Headers.WwwAuthenticate.Count).IsEqualTo(0);
        await Assert.That(response.Headers.Location).IsNull();
        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            await Assert.That((await response.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
        }
    }
}
