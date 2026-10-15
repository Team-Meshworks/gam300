using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AdministrationEndpointTests
{
    private const string InitialPassword = "Synthetic initial password 1!";
    private const string ReplacementPassword = "Synthetic replacement password 2!";

    [Test]
    [Arguments(ApplicationRoles.Administrator)]
    [Arguments(ApplicationRoles.Educator)]
    [Arguments(ApplicationRoles.Creator)]
    public async Task Provision_ActualRoute_CommitsExactRoleAndRequiredMembership(string role)
    {
        await using var fixture = await AdministratorFixtureAsync();
        var organizationId = role == ApplicationRoles.Administrator ? (Guid?)null : await CreateOrganizationAsync(fixture);
        var userName = "account-" + Guid.NewGuid().ToString("N");
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName,
            initialPassword = InitialPassword,
            orgId = organizationId,
            role,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(json.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(
            new[] { "isActive", "mustChangePassword", "orgId", "role", "userId", "userName" })).IsTrue();
        await Assert.That(json.GetProperty("userName").GetString()).IsEqualTo(userName);
        await Assert.That(json.GetProperty("role").GetString()).IsEqualTo(role);
        await Assert.That(json.GetProperty("isActive").GetBoolean()).IsTrue();
        await Assert.That(json.GetProperty("mustChangePassword").GetBoolean()).IsTrue();
        var id = json.GetProperty("userId").GetGuid();
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing provisioned account.");
        await Assert.That(await manager.CheckPasswordAsync(user, InitialPassword)).IsTrue();
        await Assert.That(user.PasswordHash == InitialPassword).IsFalse();
        await Assert.That(user.LockoutEnabled).IsTrue();
        await Assert.That((await manager.GetRolesAsync(user)).SequenceEqual([role])).IsTrue();
        var memberships = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().OrganizationMemberships
            .Where(member => member.UserId == id).ToArrayAsync();
        await Assert.That(memberships.Length).IsEqualTo(role == ApplicationRoles.Administrator ? 0 : 1);
        if (organizationId is { } orgId)
        {
            await Assert.That(memberships[0].OrganizationId).IsEqualTo(orgId);
            await Assert.That(memberships[0].RoleId).IsEqualTo(role == ApplicationRoles.Creator
                ? ApplicationRoles.CreatorId : ApplicationRoles.EducatorId);
        }
        await AssertSafeAsync(fixture, response, InitialPassword);
    }

    [Test]
    [Arguments(1, true)]
    [Arguments(256, true)]
    [Arguments(257, false)]
    [Arguments(0, false)]
    [Arguments(-1, false)]
    public async Task Organization_NameBounds_PreserveAcceptedRawValue(int length, bool valid)
    {
        await using var fixture = await AdministratorFixtureAsync();
        var name = length < 0 ? "   " : length == 1 ? "a" : new string('a', length);
        if (length == 256)
        {
            name = " " + new string('a', 254) + " ";
        }
        using var response = await SendAsync(fixture, "/api/admin/organizations", new { name });
        await Assert.That(response.StatusCode).IsEqualTo(valid ? HttpStatusCode.Created : HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var organizations = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.ToArrayAsync();
        await Assert.That(organizations.Length).IsEqualTo(valid ? 1 : 0);
        if (valid)
        {
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(json.EnumerateObject().Select(property => property.Name).Order()
                .SequenceEqual(new[] { "id", "isActive", "name" })).IsTrue();
            await Assert.That(json.GetProperty("name").GetString()).IsEqualTo(name);
            await Assert.That(organizations[0].Name).IsEqualTo(name);
        }
    }

    [Test]
    [Arguments(1, true)]
    [Arguments(256, true)]
    [Arguments(257, false)]
    [Arguments(0, false)]
    public async Task Provision_UserNameBounds_AreEnforcedBeforeCommit(int length, bool valid)
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = new string('a', length),
            initialPassword = InitialPassword,
            orgId = (Guid?)null,
            role = ApplicationRoles.Administrator,
        });
        await Assert.That(response.StatusCode).IsEqualTo(valid ? HttpStatusCode.Created : HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.CountAsync())
            .IsEqualTo(valid ? 2 : 1);
    }

    [Test]
    [Arguments("provision", 11, false)]
    [Arguments("provision", 12, true)]
    [Arguments("provision", 128, true)]
    [Arguments("provision", 129, false)]
    [Arguments("reset", 11, false)]
    [Arguments("reset", 12, true)]
    [Arguments("reset", 128, true)]
    [Arguments("reset", 129, false)]
    public async Task CredentialRoutes_EnforceLengthWithoutCompositionRules(string operation, int length, bool valid)
    {
        await using var fixture = await AdministratorFixtureAsync();
        var target = await fixture.CreateAccountAsync();
        var password = new string('a', length);
        var path = operation == "reset" ? $"/api/admin/users/{target:D}/password" : "/api/admin/users";
        object body = operation == "reset" ? new { newTemporaryPassword = password } : new
        {
            userName = "length-test",
            initialPassword = password,
            orgId = (Guid?)null,
            role = ApplicationRoles.Administrator,
        };
        using var response = await SendAsync(fixture, path, body);
        await Assert.That(response.StatusCode).IsEqualTo(!valid ? HttpStatusCode.BadRequest
            : operation == "reset" ? HttpStatusCode.NoContent : HttpStatusCode.Created);
        if (valid)
        {
            var id = operation == "reset" ? target : (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid();
            await using var scope = fixture.App.Services.CreateAsyncScope();
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing credential target.");
            await Assert.That(await manager.CheckPasswordAsync(user, password)).IsTrue();
        }
    }

    [Test]
    [Arguments("organization", "unknown")]
    [Arguments("organization", "duplicate")]
    [Arguments("organization", "wrongcase")]
    [Arguments("organization", "missing")]
    [Arguments("organization", "null")]
    [Arguments("organization", "wrongtype")]
    [Arguments("user", "unknown")]
    [Arguments("user", "duplicate")]
    [Arguments("user", "wrongcase")]
    [Arguments("user", "missing")]
    [Arguments("user", "null")]
    [Arguments("user", "wrongtype")]
    [Arguments("reset", "unknown")]
    [Arguments("reset", "duplicate")]
    [Arguments("reset", "wrongcase")]
    [Arguments("reset", "missing")]
    [Arguments("reset", "null")]
    [Arguments("reset", "wrongtype")]
    public async Task AdministrationJson_RejectsAmbiguousOrIncompleteShape(string operation, string scenario)
    {
        await using var fixture = await AdministratorFixtureAsync();
        var target = await fixture.CreateAccountAsync();
        var field = operation == "organization" ? "name" : operation == "user" ? "userName" : "newTemporaryPassword";
        var value = operation == "reset" ? ReplacementPassword : "synthetic";
        var tail = operation == "user" ? ",\"initialPassword\":\"" + InitialPassword
            + "\",\"orgId\":null,\"role\":\"Administrator\"" : "";
        var property = JsonSerializer.Serialize(field) + ":" + JsonSerializer.Serialize(value);
        var json = scenario switch
        {
            "unknown" => "{" + property + tail + ",\"unexpected\":true}",
            "duplicate" => "{" + property + "," + property + tail + "}",
            "wrongcase" => "{" + JsonSerializer.Serialize(field.ToUpperInvariant()) + ":" + JsonSerializer.Serialize(value) + tail + "}",
            "missing" => operation == "user" ? "{" + tail[1..] + "}" : "{}",
            "null" => "{" + JsonSerializer.Serialize(field) + ":null" + tail + "}",
            _ => "{" + JsonSerializer.Serialize(field) + ":42" + tail + "}",
        };
        var path = operation == "organization" ? "/api/admin/organizations" : operation == "user"
            ? "/api/admin/users" : $"/api/admin/users/{target:D}/password";
        using var response = await SendRawAsync(fixture, path, json);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(2);
        await Assert.That(await database.Organizations.CountAsync()).IsEqualTo(1);
        var user = await database.Users.SingleAsync(user => user.Id == target);
        await Assert.That(user.MustChangePassword).IsFalse();
        await AssertSafeAsync(fixture, response, ReplacementPassword);
    }

    [Test]
    [Arguments("Administrator", "present", 400)]
    [Arguments("Creator", "null", 400)]
    [Arguments("Educator", "null", 400)]
    [Arguments("Unknown", "null", 400)]
    [Arguments("creator", "present", 400)]
    [Arguments("Creator", "missing", 422)]
    [Arguments("Educator", "inactive", 422)]
    public async Task Provision_InvalidRoleOrOrganization_DoesNotLeaveAnAccount(string role, string organization, int status)
    {
        await using var fixture = await AdministratorFixtureAsync();
        Guid? orgId = organization == "null" ? null : organization == "missing" ? Guid.NewGuid() : await CreateOrganizationAsync(fixture);
        if (organization == "inactive")
        {
            await using var update = fixture.Database.Services.CreateAsyncScope();
            await update.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.Where(org => org.Id == orgId)
                .ExecuteUpdateAsync(setters => setters.SetProperty(org => org.IsActive, false));
        }
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = "rejected-account",
            initialPassword = InitialPassword,
            orgId,
            role,
        });
        await Assert.That((int)response.StatusCode).IsEqualTo(status);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.UserRoles.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Organization_EmbeddedNul_IsRejectedAtInputBoundary()
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var response = await SendAsync(fixture, "/api/admin/organizations", new { name = "invalid\0organization" });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments("anonymous", 401)]
    [Arguments("creator", 403)]
    [Arguments("forced", 403)]
    [Arguments("disabled", 401)]
    [Arguments("demoted", 403)]
    public async Task Administration_AllRoutes_RequireCurrentUnforcedAdministrator(string scenario, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        Guid? actor = null;
        if (scenario != "anonymous")
        {
            actor = await fixture.CreateAccountAsync(scenario == "creator" ? ApplicationRoles.Creator : ApplicationRoles.Administrator,
                forced: scenario == "forced");
            await fixture.SignInAsync(actor.Value);
        }
        var token = await fixture.GetCsrfAsync();
        if (scenario is "disabled" or "demoted")
        {
            await using var update = fixture.Database.Services.CreateAsyncScope();
            var database = update.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (scenario == "disabled")
            {
                await database.Users.Where(user => user.Id == actor).ExecuteUpdateAsync(setters => setters.SetProperty(user => user.IsActive, false));
            }
            else
            {
                await using var transaction = await database.Database.BeginTransactionAsync();
                await database.UserRoles.Where(role => role.UserId == actor).ExecuteDeleteAsync();
                database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = actor!.Value, RoleId = ApplicationRoles.CreatorId });
                var organization = new Organization { Id = Guid.NewGuid(), Name = "Demotion organization" };
                database.Organizations.Add(organization);
                database.OrganizationMemberships.Add(new OrganizationMembership
                {
                    UserId = actor.Value,
                    OrganizationId = organization.Id,
                    RoleId = ApplicationRoles.CreatorId,
                });
                await database.SaveChangesAsync();
                await transaction.CommitAsync();
            }
        }
        foreach (var path in new[] { "/api/admin/organizations", "/api/admin/users", $"/api/admin/users/{Guid.NewGuid():D}/password" })
        {
            using var response = await SendRawAsync(fixture, path, "{}", token);
            await Assert.That((int)response.StatusCode).IsEqualTo(status);
            await Assert.That(response.Headers.Location is null).IsTrue();
        }
    }

    [Test]
    public async Task Administration_RequiresCsrfAndNamedWriteRateLimit()
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var missing = await fixture.Client.PostAsJsonAsync("/api/admin/organizations", new { name = "missing token" });
        await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        var token = await fixture.GetCsrfAsync();
        var stranger = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(), stranger);
        var otherToken = await fixture.GetCsrfAsync(stranger);
        using var wrong = await SendAsync(fixture, "/api/admin/organizations", new { name = "wrong token" }, otherToken);
        await Assert.That(wrong.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        // CSRF failures have already consumed two of this account's twenty write permits
        for (var index = 0; index < 18; index++)
        {
            using var accepted = await SendAsync(fixture, "/api/admin/organizations", new { name = "bounded organization " + index }, token);
            await Assert.That(accepted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
        using var rejected = await SendAsync(fixture, "/api/admin/organizations", new { name = "over limit" }, token);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.TooManyRequests);
        await Assert.That(rejected.Headers.RetryAfter is not null).IsTrue();
    }

    [Test]
    public async Task Provision_NormalizedDuplicateConcurrentRequests_CreateOnlyOneAccount()
    {
        var barrier = new AccountSaveBarrierInterceptor(EntityState.Added);
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(barrier)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var orgId = await CreateOrganizationAsync(fixture);
        var token = await fixture.GetCsrfAsync();
        barrier.Arm();
        var tasks = new[] { "ConcurrentAccount", "concurrentaccount" }.Select(userName => SendAsync(fixture, "/api/admin/users", new
        {
            userName,
            initialPassword = InitialPassword,
            orgId,
            role = ApplicationRoles.Creator,
        }, token)).ToArray();
        var responses = await Task.WhenAll(tasks);
        try
        {
            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.Created)).IsEqualTo(1);
            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.Conflict)).IsEqualTo(1);
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.Users.CountAsync()).IsEqualTo(2);
            await Assert.That(await database.UserRoles.CountAsync()).IsEqualTo(2);
            await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(1);
            foreach (var response in responses)
            {
                await AssertSafeAsync(fixture, response, InitialPassword);
            }
        }
        finally
        {
            foreach (var response in responses)
            {
                response.Dispose();
            }
        }
    }

    [Test]
    public async Task Provision_CommitFailure_RollsBackUserRoleAndMembershipWithoutLeakingSecrets()
    {
        var interceptor = new AdministrationCommitInterceptor();
        await using var fixture = await AdministratorFixtureAsync(interceptor);
        var orgId = await CreateOrganizationAsync(fixture);
        interceptor.Arm();
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = "rollback-account",
            initialPassword = InitialPassword,
            orgId,
            role = ApplicationRoles.Creator,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.InternalServerError);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.UserRoles.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(0);
        await AssertSafeAsync(fixture, response, InitialPassword);
        await Assert.That(fixture.Logs.Messages.Contains("request_failure", StringComparison.Ordinal)).IsTrue();
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Reset_CommitsHashStampAndForcedState_PreservesStatusRoleMembershipAndLockout(bool inactive)
    {
        await using var fixture = await AdministratorFixtureAsync();
        var id = await fixture.CreateAccountAsync();
        var targetClient = fixture.CreateClient();
        await fixture.SignInAsync(id, targetClient);
        string oldHash;
        string oldStamp;
        Guid organizationId;
        var lockout = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        await using (var setup = fixture.Database.Services.CreateAsyncScope())
        {
            var database = setup.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync(user => user.Id == id);
            oldHash = user.PasswordHash!;
            oldStamp = user.SecurityStamp!;
            user.IsActive = !inactive;
            user.AccessFailedCount = 4;
            user.LockoutEnd = lockout;
            organizationId = await database.OrganizationMemberships.Where(member => member.UserId == id)
                .Select(member => member.OrganizationId).SingleAsync();
            await database.SaveChangesAsync();
        }
        using var response = await SendAsync(fixture, $"/api/admin/users/{id:D}/password", new { newTemporaryPassword = ReplacementPassword });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(response.Headers.Contains("Set-Cookie")).IsFalse();
        await Assert.That((await response.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync(user => user.Id == id);
            await Assert.That(user.PasswordHash == oldHash).IsFalse();
            await Assert.That(user.SecurityStamp == oldStamp).IsFalse();
            await Assert.That(user.MustChangePassword).IsTrue();
            await Assert.That(user.IsActive).IsEqualTo(!inactive);
            await Assert.That(user.AccessFailedCount).IsEqualTo(4);
            await Assert.That(user.LockoutEnd).IsEqualTo(lockout);
            await Assert.That(user.LockoutEnabled).IsTrue();
            await Assert.That(await database.UserRoles.Where(role => role.UserId == id).Select(role => role.RoleId).SingleAsync())
                .IsEqualTo(ApplicationRoles.CreatorId);
            await Assert.That(await database.OrganizationMemberships.Where(member => member.UserId == id)
                .Select(member => member.OrganizationId).SingleAsync()).IsEqualTo(organizationId);
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            await Assert.That(await manager.CheckPasswordAsync(user, ReplacementPassword)).IsTrue();
            await Assert.That(await manager.CheckPasswordAsync(user, "Synthetic-long-password1!")).IsFalse();
        }
        using var oldSession = await targetClient.GetAsync("/_test/probe");
        await Assert.That(oldSession.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await AssertSafeAsync(fixture, response, ReplacementPassword);
    }

    [Test]
    public async Task Reset_SelfAdministrator_IssuesNoReplacementCookieAndOldSessionIs401()
    {
        await using var fixture = await AdministratorFixtureAsync();
        var id = Guid.Parse(fixture.ReadTicket().Principal.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)!.Value);
        using var response = await SendAsync(fixture, $"/api/admin/users/{id:D}/password", new { newTemporaryPassword = ReplacementPassword });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(response.Headers.Contains("Set-Cookie")).IsFalse();
        using var next = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(next.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await fixture.SignInAsync(id);
        using var forced = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(forced.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
    }

    [Test]
    public async Task Reset_CommitFailure_RollsBackCredentialsAndKeepsExistingCookieUsable()
    {
        var interceptor = new AdministrationCommitInterceptor();
        await using var fixture = await AdministratorFixtureAsync(interceptor);
        var id = await fixture.CreateAccountAsync();
        var targetClient = fixture.CreateClient();
        await fixture.SignInAsync(id, targetClient);
        string hash;
        string stamp;
        string concurrency;
        await using (var before = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await before.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync(user => user.Id == id);
            hash = user.PasswordHash!;
            stamp = user.SecurityStamp!;
            concurrency = user.ConcurrencyStamp!;
        }
        interceptor.Arm();
        using var response = await SendAsync(fixture, $"/api/admin/users/{id:D}/password", new { newTemporaryPassword = ReplacementPassword });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.InternalServerError);
        await using (var after = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await after.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync(user => user.Id == id);
            await Assert.That(user.PasswordHash == hash && user.SecurityStamp == stamp && user.ConcurrencyStamp == concurrency).IsTrue();
            await Assert.That(user.MustChangePassword).IsFalse();
        }
        using var existing = await targetClient.GetAsync("/_test/probe");
        await Assert.That(existing.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await AssertSafeAsync(fixture, response, ReplacementPassword);
    }

    [Test]
    public async Task Reset_TwoOldSnapshots_OneCommitOneConflict_NoAutomaticRetry()
    {
        var barrier = new AccountSaveBarrierInterceptor(EntityState.Modified);
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(barrier)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var id = await fixture.CreateAccountAsync();
        var token = await fixture.GetCsrfAsync();
        var passwords = new[] { "Concurrent reset password A", "Concurrent reset password B" };
        barrier.Arm();
        var responses = await Task.WhenAll(passwords.Select(password => SendAsync(fixture, $"/api/admin/users/{id:D}/password",
            new { newTemporaryPassword = password }, token)));
        try
        {
            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.NoContent)).IsEqualTo(1);
            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.Conflict)).IsEqualTo(1);
            await using var scope = fixture.App.Services.CreateAsyncScope();
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing reset target.");
            for (var index = 0; index < passwords.Length; index++)
            {
                await Assert.That(await manager.CheckPasswordAsync(user, passwords[index]))
                    .IsEqualTo(responses[index].StatusCode == HttpStatusCode.NoContent);
            }
            await Assert.That(user.MustChangePassword).IsTrue();
        }
        finally
        {
            foreach (var response in responses)
            {
                response.Dispose();
            }
        }
    }

    [Test]
    public async Task Reset_MissingTarget_Is404OnlyAfterAdministratorAuthorization()
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var response = await SendAsync(fixture, $"/api/admin/users/{Guid.NewGuid():D}/password", new { newTemporaryPassword = ReplacementPassword });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task Provision_PasswordWhitespaceIsPreservedAndIdentityUserNameIsNotTrimmed()
    {
        await using var fixture = await AdministratorFixtureAsync();
        const string password = "  unchanged password  ";
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = "raw-name",
            initialPassword = password,
            orgId = (Guid?)null,
            role = ApplicationRoles.Administrator,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid();
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing raw password target.");
        await Assert.That(await manager.CheckPasswordAsync(user, password)).IsTrue();
        await Assert.That(await manager.CheckPasswordAsync(user, password.Trim())).IsFalse();
        using var spaced = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = " raw-name ",
            initialPassword = password,
            orgId = (Guid?)null,
            role = ApplicationRoles.Administrator,
        });
        await Assert.That(spaced.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
    }

    [Test]
    [Arguments("{\"name\":\"\\uD800\"}")]
    [Arguments("{\"\\uD800\":\"synthetic\"}")]
    [Arguments("{\"name\":\"a\",\"na\\u006de\":\"b\"}")]
    public async Task Organization_MalformedUnicodeOrEscapedDuplicate_IsFixed400(string json)
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var response = await SendRawAsync(fixture, "/api/admin/organizations", json);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await AssertSafeAsync(fixture, response, HttpsApplicationFixture.SecretSentinel);
    }

    [Test]
    public async Task Organization_InvalidRawUtf8_IsFixed400()
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/admin/organizations")
        {
            Content = new ByteArrayContent([123, 34, 110, 97, 109, 101, 34, 58, 34, 0xC3, 0x28, 34, 125]),
        };
        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
    }

    [Test]
    public async Task Provision_FailedIdentityResultAfterUserSave_RollsBackWithoutOrphanOrSecretDescription()
    {
        var validator = new RejectSecondUserValidation();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddSingleton<IUserValidator<ApplicationUser>>(validator));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var orgId = await CreateOrganizationAsync(fixture);
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = "identity-rollback",
            initialPassword = InitialPassword,
            orgId,
            role = ApplicationRoles.Creator,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.UserRoles.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(0);
        await AssertSafeAsync(fixture, response, InitialPassword);
    }

    [Test]
    public async Task Reset_SelfAfterStandardRenewal_AnyRenewedCookieRetainsOldStampAndOriginalCutoff()
    {
        await using var fixture = await AdministratorFixtureAsync();
        var before = fixture.ReadTicket();
        var id = Guid.Parse(before.Principal.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)!.Value);
        var token = await fixture.GetCsrfAsync();
        fixture.Clock.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
        using var response = await SendAsync(fixture, $"/api/admin/users/{id:D}/password",
            new { newTemporaryPassword = ReplacementPassword }, token);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var after = fixture.ReadTicket();
        await Assert.That(after.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey])
            .IsEqualTo(before.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]);
        await Assert.That(after.Principal.FindFirst("AspNet.Identity.SecurityStamp")?.Value)
            .IsEqualTo(before.Principal.FindFirst("AspNet.Identity.SecurityStamp")?.Value);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync(user => user.Id == id);
            await Assert.That(user.SecurityStamp == after.Principal.FindFirst("AspNet.Identity.SecurityStamp")?.Value).IsFalse();
        }
        using var next = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(next.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
    }
    [Test]
    public async Task Provision_NullableOrganizationKeyIsStillRequired()
    {
        await using var fixture = await AdministratorFixtureAsync();
        using var response = await SendAsync(fixture, "/api/admin/users", new
        {
            userName = "missing-org-key",
            initialPassword = InitialPassword,
            role = ApplicationRoles.Administrator,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.CountAsync()).IsEqualTo(1);
    }
    private static async Task<HttpsApplicationFixture> AdministratorFixtureAsync(AdministrationCommitInterceptor? interceptor = null)
    {
        var fixture = await HttpsApplicationFixture.CreateAsync(interceptor is null ? null : builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(interceptor)));
        try
        {
            await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
            return fixture;
        }
        catch
        {
            await fixture.DisposeAsync();
            throw;
        }
    }

    private static async Task<Guid> CreateOrganizationAsync(HttpsApplicationFixture fixture)
    {
        using var response = await SendAsync(fixture, "/api/admin/organizations", new { name = "Synthetic admin organization" });
        if (response.StatusCode != HttpStatusCode.Created)
        {
            throw new InvalidOperationException("Expected a synthetic organization to be created.");
        }
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static Task<HttpResponseMessage> SendAsync(HttpsApplicationFixture fixture, string path, object body, string? token = null)
        => SendRawAsync(fixture, path, JsonSerializer.Serialize(body), token);

    private static async Task<HttpResponseMessage> SendRawAsync(HttpsApplicationFixture fixture, string path, string json, string? token = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }

    private static async Task AssertSafeAsync(HttpsApplicationFixture fixture, HttpResponseMessage response, string secret)
    {
        var text = await response.Content.ReadAsStringAsync();
        await Assert.That(text.Contains(secret, StringComparison.Ordinal)).IsFalse();
        await Assert.That(text.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        await Assert.That(text.Contains("passwordHash", StringComparison.OrdinalIgnoreCase)).IsFalse();
        await Assert.That(text.Contains("securityStamp", StringComparison.OrdinalIgnoreCase)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(secret, StringComparison.Ordinal)
            || fixture.Logs.Messages.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
    }
}
