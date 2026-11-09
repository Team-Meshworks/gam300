using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AccountDirectoryTests))]
public sealed class AccountDirectoryTests
{
    [Test]
    public async Task Directory_ReadsReturnOnlyPublicFieldsAndPersistedInactiveRecords()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(administrator);
        var userId = await fixture.CreateAccountAsync(forced: true);
        var educatorId = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        Guid orgId;
        var projectId = Guid.NewGuid();
        string userName;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync(row => row.Id == userId);
            user.IsActive = false;
            user.DisplayName = "Directory Member Display";
            userName = user.UserName!;
            orgId = await database.OrganizationMemberships.Where(row => row.UserId == userId)
                .Select(row => row.OrganizationId).SingleAsync();
            var organization = await database.Organizations.SingleAsync(row => row.Id == orgId);
            organization.Name = "Synthetic 100%_\\ Organization";
            organization.IsActive = false;
            await database.OrganizationMemberships.Where(row => row.UserId == educatorId)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, orgId));
            database.Projects.Add(new Project
            {
                Id = projectId,
                OrganizationId = orgId,
                SchemaVersion = 1,
                DocumentJson = ProjectTestDocuments.Create(projectId, "Organisation totals"),
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = projectId, UserId = userId, CanEdit = true });
            await database.SaveChangesAsync();
        }

        using var userResponse = await fixture.Client.GetAsync($"/api/v1/admin/users/{userId:D}");
        await Assert.That(userResponse.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var account = await userResponse.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(account.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(
            new[] { "displayName", "isActive", "mustChangePassword", "orgId", "role", "userId", "userName" })).IsTrue();
        await Assert.That(account.GetProperty("userId").GetGuid()).IsEqualTo(userId);
        await Assert.That(account.GetProperty("userName").GetString()).IsEqualTo(userName);
        await Assert.That(account.GetProperty("orgId").GetGuid()).IsEqualTo(orgId);
        await Assert.That(account.GetProperty("role").GetString()).IsEqualTo(ApplicationRoles.Creator);
        await Assert.That(account.GetProperty("isActive").GetBoolean()).IsFalse();
        await Assert.That(account.GetProperty("mustChangePassword").GetBoolean()).IsTrue();
        await Assert.That(userResponse.Headers.CacheControl?.NoStore).IsTrue();

        var filtered = await GetJsonAsync(fixture, $"/api/v1/admin/users?role=Creator&orgId={orgId:D}&isActive=false&q={userName.ToUpperInvariant()}");
        await Assert.That(filtered.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(filtered.GetProperty("items")[0].GetProperty("userId").GetGuid()).IsEqualTo(userId);
        await Assert.That(filtered.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        var educators = await GetJsonAsync(fixture, $"/api/v1/admin/users?role=Educator&orgId={orgId:D}");
        await Assert.That(educators.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(educators.GetProperty("items")[0].GetProperty("userId").GetGuid()).IsEqualTo(educatorId);
        var empty = await GetJsonAsync(fixture, $"/api/v1/admin/users?role=Creator&orgId={orgId:D}&isActive=true");
        await Assert.That(empty.GetProperty("items").GetArrayLength()).IsEqualTo(0);

        var organizationJson = await GetJsonAsync(fixture, $"/api/v1/admin/organizations/{orgId:D}");
        await Assert.That(organizationJson.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(
            new[] { "id", "isActive", "name" })).IsTrue();
        await Assert.That(organizationJson.GetProperty("id").GetGuid()).IsEqualTo(orgId);
        await Assert.That(organizationJson.GetProperty("name").GetString()).IsEqualTo("Synthetic 100%_\\ Organization");
        await Assert.That(organizationJson.GetProperty("isActive").GetBoolean()).IsFalse();
        var organizations = await GetJsonAsync(fixture, "/api/v1/admin/organizations?isActive=false&q="
            + Uri.EscapeDataString("100%_\\ ORGANIZATION"));
        await Assert.That(organizations.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(organizations.GetProperty("items")[0].GetProperty("id").GetGuid()).IsEqualTo(orgId);
        var totals = organizations.GetProperty("items")[0];
        await Assert.That(totals.GetProperty("projectCount").GetInt32()).IsEqualTo(1);
        await Assert.That(totals.GetProperty("facilitatorCount").GetInt32()).IsEqualTo(1);
        await Assert.That(totals.GetProperty("creatorCount").GetInt32()).IsEqualTo(1);

        // Organisation discovery also follows member account names without exposing account records in the list
        foreach (var term in new[] { userName.ToUpperInvariant(), "DIRECTORY MEMBER DISPLAY" })
        {
            var matching = await GetJsonAsync(fixture, "/api/v1/admin/organizations?q=" + Uri.EscapeDataString(term));
            await Assert.That(matching.GetProperty("items").GetArrayLength()).IsEqualTo(1);
            await Assert.That(matching.GetProperty("items")[0].GetProperty("id").GetGuid()).IsEqualTo(orgId);
        }
        var literal = await GetJsonAsync(fixture, "/api/v1/admin/users?q=%25");
        await Assert.That(literal.GetProperty("items").GetArrayLength()).IsEqualTo(0);

        using var noToken = await fixture.Client.DeleteAsync($"/api/v1/admin/users/{userId:D}");
        await AuthTestRequests.AssertProblemAsync(noToken, HttpStatusCode.BadRequest, "csrf_invalid");
        using var protectedAdministrator = await DeleteAsync(fixture, administrator);
        await AuthTestRequests.AssertProblemAsync(protectedAdministrator, HttpStatusCode.Forbidden, "account_delete_forbidden");
        using var missing = await DeleteAsync(fixture, Guid.NewGuid());
        await AuthTestRequests.AssertProblemAsync(missing, HttpStatusCode.NotFound, "account_not_found");
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Users.Where(row => row.Id == userId).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, true));
            await database.Organizations.Where(row => row.Id == orgId).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, true));
        }
        using var targetClient = fixture.CreateClient();
        await fixture.SignInAsync(userId, targetClient);
        using var liveSession = await targetClient.GetAsync("/api/v1/auth/session");
        await Assert.That(liveSession.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var deleted = await DeleteAsync(fixture, userId);
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var repeated = await DeleteAsync(fixture, userId);
        await Assert.That(repeated.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var staleSession = await targetClient.GetAsync("/api/v1/auth/session");
        await Assert.That(staleSession.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        using var freshLogin = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/login",
            new { userName, password = AuthTestRequests.CurrentPassword }, targetClient);
        await AuthTestRequests.AssertProblemAsync(freshLogin, HttpStatusCode.Unauthorized, "login_failed");
        using var removed = await fixture.Client.GetAsync($"/api/v1/admin/users/{userId:D}");
        await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var reactivate = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/admin/users/{userId:D}/active")
        {
            Content = JsonContent.Create(new { isActive = true }),
        };
        reactivate.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var unavailable = await fixture.Client.SendAsync(reactivate);
        await Assert.That(unavailable.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var reset = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/users/{userId:D}/password",
            new { newTemporaryPassword = AuthTestRequests.NewPassword });
        await Assert.That(reset.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var reuse = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users", new
        {
            userName,
            role = ApplicationRoles.Creator,
            orgId,
            initialPassword = AuthTestRequests.CurrentPassword,
        });
        await AuthTestRequests.AssertProblemAsync(reuse, HttpStatusCode.Conflict, "username_taken");
        var remaining = await GetJsonAsync(fixture, $"/api/v1/admin/users?orgId={orgId:D}");
        await Assert.That(remaining.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(remaining.GetProperty("items")[0].GetProperty("userId").GetGuid()).IsEqualTo(educatorId);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var retained = await database.Users.SingleAsync(row => row.Id == userId);
            await Assert.That(retained.IsDeleted).IsTrue();
            await Assert.That(retained.IsActive).IsFalse();
            await Assert.That(retained.UserName).IsEqualTo(userName);
            await Assert.That(await database.Projects.AnyAsync(row => row.Id == projectId)).IsTrue();
            await Assert.That(await database.ProjectAssignments.AnyAsync(row => row.ProjectId == projectId && row.UserId == userId)).IsTrue();
            await Assert.That(await database.OrganizationMemberships.AnyAsync(row => row.UserId == userId)).IsTrue();
        }

    }

    [Test]
    [Arguments("users", "userId")]
    [Arguments("organizations", "id")]
    public async Task Directory_CursorPagesReturnEachRecordExactlyOnce(string resource, string idField)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        await fixture.CreateAccountAsync();
        await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var first = await GetJsonAsync(fixture, $"/api/v1/admin/{resource}?limit=1");
        var firstId = first.GetProperty("items")[0].GetProperty(idField).GetGuid();
        await Assert.That(first.GetProperty("nextCursor").GetGuid()).IsEqualTo(firstId);
        var remaining = await GetJsonAsync(fixture, $"/api/v1/admin/{resource}?limit=100&cursor={firstId:D}");
        var remainingIds = remaining.GetProperty("items").EnumerateArray().Select(row => row.GetProperty(idField).GetGuid()).ToArray();
        await Assert.That(remainingIds.Length).IsEqualTo(resource == "users" ? 2 : 1);
        await Assert.That(remainingIds.All(id => id.CompareTo(firstId) > 0)).IsTrue();
        await Assert.That(remainingIds.SequenceEqual(remainingIds.Order())).IsTrue();
        await Assert.That(remaining.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        var all = await GetJsonAsync(fixture, $"/api/v1/admin/{resource}");
        await Assert.That(all.GetProperty("items").EnumerateArray().Select(row => row.GetProperty(idField).GetGuid())
            .SequenceEqual(new[] { firstId }.Concat(remainingIds))).IsTrue();
        using var missing = await fixture.Client.GetAsync($"/api/v1/admin/{resource}/{Guid.NewGuid():D}");
        await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    [Arguments("limit=0")]
    [Arguments("limit=101")]
    [Arguments("limit=1&limit=2")]
    [Arguments("cursor=invalid")]
    [Arguments("cursor=00000000-0000-0000-0000-000000000000")]
    [Arguments("isActive=True")]
    [Arguments("q=a&q=b")]
    [Arguments("unexpected=true")]
    [Arguments("q=%00")]
    public async Task Directory_InvalidQueryIsRejected(string query)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        foreach (var resource in new[] { "users", "organizations" })
        {
            using var response = await fixture.Client.GetAsync($"/api/v1/admin/{resource}?{query}");
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(json.GetProperty("code").GetString()).IsEqualTo("invalid_directory_query");
        }
    }

    [Test]
    public async Task Directory_QueryBoundsAndResourceSpecificFiltersAreValidated()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        foreach (var path in new[] { "users?role=administrator", "users?orgId=invalid", "organizations?role=Creator",
            "users?q=" + new string('a', 257), "organizations?q=" + new string('a', 257) })
        {
            using var response = await fixture.Client.GetAsync("/api/v1/admin/" + path);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        var valid = await GetJsonAsync(fixture, "/api/v1/admin/users?q=" + new string('a', 256));
        await Assert.That(valid.GetProperty("items").GetArrayLength()).IsEqualTo(0);
    }

    [Test]
    [Arguments("anonymous", 401)]
    [Arguments(ApplicationRoles.Creator, 403)]
    [Arguments(ApplicationRoles.Educator, 403)]
    [Arguments("forced", 403)]
    [Arguments("disabled", 401)]
    public async Task Directory_AllReadsRequireCurrentFullAdministrator(string actor, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var target = await fixture.CreateAccountAsync();
        if (actor != "anonymous")
        {
            var id = await fixture.CreateAccountAsync(actor is "forced" or "disabled" ? ApplicationRoles.Administrator : actor,
                forced: actor == "forced");
            await fixture.SignInAsync(id, forgedRole: ApplicationRoles.Administrator);
            if (actor == "disabled")
            {
                await using var scope = fixture.Database.Services.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(row => row.Id == id)
                    .ExecuteUpdateAsync(setters => setters.SetProperty(row => row.IsActive, false));
            }
        }
        foreach (var path in new[] { "users", $"users/{target:D}", "organizations", $"organizations/{Guid.NewGuid():D}" })
        {
            using var response = await fixture.Client.GetAsync("/api/v1/admin/" + path);
            await Assert.That((int)response.StatusCode).IsEqualTo(status);
            await Assert.That((await response.Content.ReadAsStringAsync()).Contains(target.ToString("D"), StringComparison.Ordinal)).IsFalse();
        }
        using var deletion = await DeleteAsync(fixture, target);
        await Assert.That((int)deletion.StatusCode).IsEqualTo(status);
    }

    private static async Task<HttpResponseMessage> DeleteAsync(HttpsApplicationFixture fixture, Guid id)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/admin/users/{id:D}");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }

    private static async Task<JsonElement> GetJsonAsync(HttpsApplicationFixture fixture, string path)
    {
        using var response = await fixture.Client.GetAsync(path);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }
}
