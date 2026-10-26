using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class RequestPrincipalTests
{
    [Test]
    public async Task ProtectedProbe_Anonymous_Is401WithoutRedirect()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var response = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await Assert.That(response.Headers.Location is null).IsTrue();
        await Assert.That(response.Content.Headers.ContentType?.MediaType).IsEqualTo("application/problem+json");
    }

    [Test]
    [Arguments("disabled")]
    [Arguments("missing-membership")]
    [Arguments("missing-role")]
    [Arguments("inactive-organization")]
    [Arguments("stale-stamp")]
    [Arguments("renamed-role")]
    public async Task ProtectedProbe_CurrentDatabaseStateInvalidatesExistingCookie(string mutation)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(id);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync(user => user.Id == id);
            var membership = await database.OrganizationMemberships.SingleAsync(member => member.UserId == id);
            switch (mutation)
            {
                case "disabled": user.IsActive = false; break;
                case "missing-membership": database.OrganizationMemberships.Remove(membership); break;
                case "missing-role":
                    database.OrganizationMemberships.Remove(membership);
                    database.UserRoles.Remove(await database.UserRoles.SingleAsync(role => role.UserId == id));
                    break;
                case "inactive-organization":
                    (await database.Organizations.SingleAsync(org => org.Id == membership.OrganizationId)).IsActive = false;
                    break;
                case "stale-stamp": user.SecurityStamp = Guid.NewGuid().ToString("N"); break;
                case "renamed-role":
                    (await database.Roles.SingleAsync(role => role.Id == ApplicationRoles.CreatorId)).Name = "RenamedCreator";
                    break;
            }
            await database.SaveChangesAsync();
        }
        using var response = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await Assert.That(fixture.Cookies.GetCookies(fixture.Address)[HttpsApplicationFixture.CookieName] is null).IsTrue();
    }

    [Test]
    [Arguments("creator-to-educator")]
    [Arguments("administrator-to-creator")]
    public async Task ProtectedProbe_RoleAndNameChange_UseCurrentDatabaseAuthority(string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var previousRole = scenario == "administrator-to-creator" ? ApplicationRoles.Administrator : ApplicationRoles.Creator;
        var nextRole = scenario == "administrator-to-creator" ? ApplicationRoles.Creator : ApplicationRoles.Educator;
        var nextRoleId = scenario == "administrator-to-creator" ? ApplicationRoles.CreatorId : ApplicationRoles.EducatorId;
        var id = await fixture.CreateAccountAsync(previousRole);
        await fixture.SignInAsync(id);
        Guid organizationId;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await using var transaction = await database.Database.BeginTransactionAsync();
            var membership = await database.OrganizationMemberships.SingleOrDefaultAsync(member => member.UserId == id);
            if (membership is not null)
            {
                organizationId = membership.OrganizationId;
                database.OrganizationMemberships.Remove(membership);
                await database.SaveChangesAsync();
            }
            else
            {
                organizationId = Guid.NewGuid();
                database.Organizations.Add(new Organization { Id = organizationId, Name = "Demoted administrator school" });
                await database.SaveChangesAsync();
            }
            database.UserRoles.Remove(await database.UserRoles.SingleAsync(role => role.UserId == id));
            await database.SaveChangesAsync();
            database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = id, RoleId = nextRoleId });
            await database.SaveChangesAsync();
            database.OrganizationMemberships.Add(new OrganizationMembership
            {
                OrganizationId = organizationId,
                UserId = id,
                RoleId = nextRoleId,
            });
            var user = await database.Users.SingleAsync(user => user.Id == id);
            user.UserName = "current-name";
            user.NormalizedUserName = "CURRENT-NAME";
            await database.SaveChangesAsync();
            await transaction.CommitAsync();
        }
        using var administrator = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(administrator.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var response = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(json.GetProperty("role").GetString()).IsEqualTo(nextRole);
        await Assert.That(json.GetProperty("userName").GetString()).IsEqualTo("current-name");
        await Assert.That(json.GetProperty("organizationId").GetGuid()).IsEqualTo(organizationId);
    }

    [Test]
    public async Task ForgedDuplicateRoleClaimsAcrossIdentities_CannotGrantAdministrator()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(id, forgedRole: ApplicationRoles.Administrator);
        using var admin = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(admin.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var probe = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(probe.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var json = await probe.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(json.GetProperty("role").GetString()).IsEqualTo(ApplicationRoles.Creator);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var expectedOrganization = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .OrganizationMemberships.Where(member => member.UserId == id).Select(member => member.OrganizationId).SingleAsync();
        await Assert.That(json.GetProperty("organizationId").GetGuid()).IsEqualTo(expectedOrganization);
    }

    [Test]
    [Arguments(ApplicationRoles.Creator)]
    [Arguments(ApplicationRoles.Administrator)]
    public async Task ForcedPasswordState_IsRestrictedToCurrentAccountAuthPathAndVerb(string role)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync(role, forced: true);
        await fixture.SignInAsync(id);
        using var ordinary = await fixture.Client.GetAsync("/_test/probe");
        using var administrator = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(administrator.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var arbitraryCurrent = await fixture.Client.GetAsync("/_test/current");
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(ordinary.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await Assert.That(arbitraryCurrent.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var sessionJson = await session.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(sessionJson.GetProperty("mustChangePassword").GetBoolean()).IsTrue();
        var token = await fixture.GetCsrfAsync();
        using var wrongVerb = new HttpRequestMessage(HttpMethod.Put, "/api/auth/logout");
        wrongVerb.Headers.Add("X-CSRF-TOKEN", token);
        using var rejected = await fixture.Client.SendAsync(wrongVerb);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var allowed = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
        allowed.Headers.Add("X-CSRF-TOKEN", token);
        using var allowedResponse = await fixture.Client.SendAsync(allowed);
        await Assert.That(allowedResponse.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
    }
}
