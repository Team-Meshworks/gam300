using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountProfileTests
{
    [Test]
    public async Task Directory_OrganizationProjectsAreBoundedAndIsolated()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var first = await fixture.CreateAccountAsync();
        var other = await fixture.CreateAccountAsync();
        Guid organizationId;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            organizationId = (await database.OrganizationMemberships.SingleAsync(row => row.UserId == first)).OrganizationId;
            var otherId = (await database.OrganizationMemberships.SingleAsync(row => row.UserId == other)).OrganizationId;
            foreach (var orgId in new[] { organizationId, organizationId, otherId })
            {
                var id = Guid.NewGuid();
                database.Projects.Add(new Project
                {
                    Id = id,
                    OrganizationId = orgId,
                    SchemaVersion = 1,
                    DocumentJson = ProjectTestDocuments.Create(id, orgId == organizationId ? "Visible project" : "Other organisation"),
                    UpdatedAt = DateTimeOffset.UtcNow
                });
            }
            await database.SaveChangesAsync();
        }
        var path = $"/api/admin/organizations/{organizationId}/projects";
        var page = await fixture.Client.GetFromJsonAsync<JsonElement>(path + "?limit=1");
        await Assert.That(page.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(page.GetProperty("items")[0].GetProperty("title").GetString()).IsEqualTo("Visible project");
        var next = await fixture.Client.GetFromJsonAsync<JsonElement>(path + "?limit=1&cursor=" + page.GetProperty("nextCursor").GetString());
        await Assert.That(next.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(next.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        using var unbounded = await fixture.Client.GetAsync(path + "?limit=21");
        await Assert.That(unbounded.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var missing = await fixture.Client.GetAsync($"/api/admin/organizations/{Guid.NewGuid()}/projects");
        await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var member = fixture.CreateClient();
        await fixture.SignInAsync(first, member);
        using var denied = await member.GetAsync(path);
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
    }

    [Test]
    public async Task Profile_OverridesPersistTogetherAndReplaceLoginCredentials()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var target = await fixture.CreateAccountAsync();
        using var oldClient = fixture.CreateClient();
        await fixture.SignInAsync(target, oldClient);
        using var response = await PatchAsync(fixture, target, new
        {
            displayName = "Aisyah Abdullah",
            userName = "aisyah.updated",
            role = "Educator",
            newTemporaryPassword = AuthTestRequests.NewPassword,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var account = await response.Content.ReadFromJsonAsync<ProvisionedAccount>();
        await Assert.That(account!.DisplayName).IsEqualTo("Aisyah Abdullah");
        await Assert.That(account.Role).IsEqualTo("Educator");
        await Assert.That(account.MustChangePassword).IsTrue();
        await AuthTestRequests.AssertSafeAsync(fixture, response);
        using var oldSession = await oldClient.GetAsync("/api/auth/session");
        await Assert.That(oldSession.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        using var reloaded = await fixture.Client.GetAsync($"/api/admin/users/{target}");
        await Assert.That(await reloaded.Content.ReadFromJsonAsync<ProvisionedAccount>()).IsEqualTo(account);
        using var search = await fixture.Client.GetAsync("/api/admin/users?q=ABDULLAH");
        var page = await search.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(page.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = (await users.FindByIdAsync(target.ToString()))!;
        await Assert.That(await users.CheckPasswordAsync(user, AuthTestRequests.NewPassword)).IsTrue();
        await Assert.That(await users.CheckPasswordAsync(user, AuthTestRequests.CurrentPassword)).IsFalse();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await database.OrganizationMemberships.SingleAsync(row => row.UserId == target)).RoleId).IsEqualTo(ApplicationRoles.EducatorId);
        using var login = await AuthTestRequests.PostAsync(fixture, "/api/auth/login", new { userName = "aisyah.updated", password = AuthTestRequests.NewPassword }, oldClient);
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var session = await oldClient.GetAsync("/api/auth/session");
        var details = await session.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(details.GetProperty("displayName").GetString()).IsEqualTo("Aisyah Abdullah");
        await Assert.That(details.GetProperty("role").GetString()).IsEqualTo("Educator");
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task Profile_InvalidPasswordOrDuplicateUsernameRollsBackAllOverrides(bool duplicate)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddScoped<IPasswordValidator<ApplicationUser>, RejectProfilePassword>());
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        var target = await fixture.CreateAccountAsync();
        var before = await ReadAsync(fixture, target);
        using var response = await PatchAsync(fixture, target, new
        {
            displayName = "Must not persist",
            role = "Educator",
            userName = duplicate ? await AuthTestRequests.UserNameAsync(fixture, admin) : "new.valid.name",
            newTemporaryPassword = duplicate ? AuthTestRequests.NewPassword : "rejected-test-password",
        });
        await Assert.That(response.StatusCode).IsEqualTo(duplicate ? HttpStatusCode.Conflict : HttpStatusCode.BadRequest);
        await Assert.That(await ReadAsync(fixture, target)).IsEqualTo(before);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        await Assert.That(await users.CheckPasswordAsync((await users.FindByIdAsync(target.ToString()))!, AuthTestRequests.CurrentPassword)).IsTrue();
    }

    [Test]
    public async Task Profile_ClassHistoryPreventsRoleChangeButAllowsNameOverride()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var target = await fixture.CreateAccountAsync();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var membership = await database.OrganizationMemberships.SingleAsync(row => row.UserId == target);
            var classroom = new Classroom { Id = Guid.NewGuid(), OrganizationId = membership.OrganizationId, Name = "History class" };
            database.Classrooms.Add(classroom);
            database.ClassroomMembers.Add(new ClassroomMember { ClassroomId = classroom.Id, OrganizationId = membership.OrganizationId, UserId = target, RoleId = membership.RoleId, IsActive = false });
            await database.SaveChangesAsync();
        }
        using var refused = await PatchAsync(fixture, target, new { role = "Educator", displayName = "Uncommitted" });
        await AuthTestRequests.AssertProblemAsync(refused, HttpStatusCode.Conflict, "account_role_in_use");
        using var accepted = await PatchAsync(fixture, target, new { displayName = "Updated Name" });
        await Assert.That(accepted.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await ReadAsync(fixture, target)).Role).IsEqualTo("Creator");
    }

    [Test]
    [Arguments("anonymous", 401)]
    [Arguments("Creator", 403)]
    [Arguments("Educator", 403)]
    [Arguments("forced", 403)]
    public async Task Profile_OnlyFullAdministratorsMayOverride(string actor, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var target = await fixture.CreateAccountAsync();
        if (actor != "anonymous")
        {
            await fixture.SignInAsync(await fixture.CreateAccountAsync(actor == "forced" ? "Administrator" : actor, forced: actor == "forced"));
        }

        using var response = await PatchAsync(fixture, target, new { displayName = "Denied" });
        await Assert.That((int)response.StatusCode).IsEqualTo(status);
    }

    [Test]
    public async Task Profile_RequiresCsrfAndRejectsAdministratorEscalation()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        var target = await fixture.CreateAccountAsync();
        using var missingCsrf = await fixture.Client.PatchAsJsonAsync($"/api/admin/users/{target}", new { displayName = "Denied" });
        await Assert.That(missingCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var escalation = await PatchAsync(fixture, target, new { role = "Administrator" });
        await Assert.That(escalation.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var demotion = await PatchAsync(fixture, admin, new { role = "Creator" });
        await Assert.That(demotion.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var invalidName = await PatchAsync(fixture, target, new { displayName = " \t " });
        await Assert.That(invalidName.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
    }

    private static async Task<ProvisionedAccount> ReadAsync(HttpsApplicationFixture fixture, Guid id) =>
        (await fixture.Client.GetFromJsonAsync<ProvisionedAccount>($"/api/admin/users/{id}"))!;

    private sealed class RejectProfilePassword : IPasswordValidator<ApplicationUser>
    {
        public Task<IdentityResult> ValidateAsync(UserManager<ApplicationUser> manager, ApplicationUser user, string? password) =>
            Task.FromResult(password == "rejected-test-password"
                ? IdentityResult.Failed(new IdentityError { Code = "RejectedPassword" }) : IdentityResult.Success);
    }

    private static async Task<HttpResponseMessage> PatchAsync(HttpsApplicationFixture fixture, Guid id, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"/api/admin/users/{id}") { Content = JsonContent.Create(body) };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }
}
