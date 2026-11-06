using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class OrganizationLifecycleTests
{
    [Test]
    [Arguments(ApplicationRoles.Creator)]
    [Arguments(ApplicationRoles.Educator)]
    public async Task OrganizationLifecycle_DisableAndEnablePreserveDataAndControlMemberAccess(string role)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var member = await fixture.CreateAccountAsync(role);
        var cookies = new CookieContainer();
        using var memberClient = fixture.CreateClient(cookies);
        await fixture.SignInAsync(member, memberClient);
        await fixture.SignInAsync(administrator);
        var captured = cookies.GetCookies(fixture.Address)[fixture.CookieName]!.Value;
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/projects",
            new { title = "Retained project", environmentAssetId = "test-room-v1" }, memberClient);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projectId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        var orgId = await OrganizationIdAsync(fixture, member);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var userBefore = await database.Users.AsNoTracking().SingleAsync(row => row.Id == member);
        var projectBefore = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId);
        using var disabled = await PatchAsync(fixture, orgId, false);
        await Assert.That(disabled.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That((await database.Organizations.AsNoTracking().SingleAsync(row => row.Id == orgId)).IsActive).IsFalse();
        using var memberRead = await memberClient.GetAsync($"/api/projects/{projectId:D}");
        await Assert.That(memberRead.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        using var loginClient = fixture.CreateClient();
        using var deniedLogin = await AuthTestRequests.PostAsync(fixture, "/api/auth/login",
            new { userName = userBefore.UserName, password = AuthTestRequests.CurrentPassword }, loginClient);
        await Assert.That(deniedLogin.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        using var adminRead = await fixture.Client.GetAsync($"/api/projects/{projectId:D}");
        await Assert.That(adminRead.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var again = await PatchAsync(fixture, orgId, false);
        await Assert.That(again.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var directory = await fixture.Client.GetAsync($"/api/admin/organizations/{orgId:D}");
        await Assert.That((await directory.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("isActive").GetBoolean()).IsFalse();
        using var enabled = await PatchAsync(fixture, orgId, true);
        await Assert.That(enabled.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var replayCookies = new CookieContainer();
        replayCookies.Add(fixture.Address, new Cookie(fixture.CookieName, captured, "/") { Secure = true });
        using var replay = fixture.CreateClient(replayCookies);
        using var restoredSession = await replay.GetAsync($"/api/projects/{projectId:D}");
        await Assert.That(restoredSession.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var acceptedLogin = await AuthTestRequests.PostAsync(fixture, "/api/auth/login",
            new { userName = userBefore.UserName, password = AuthTestRequests.CurrentPassword }, loginClient);
        await Assert.That(acceptedLogin.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var freshRead = await loginClient.GetAsync($"/api/projects/{projectId:D}");
        await Assert.That(freshRead.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var userAfter = await database.Users.AsNoTracking().SingleAsync(row => row.Id == member);
        await Assert.That(userAfter.IsActive).IsTrue();
        await Assert.That(userAfter.SecurityStamp).IsEqualTo(userBefore.SecurityStamp);
        await Assert.That(userAfter.PasswordHash).IsEqualTo(userBefore.PasswordHash);
        await Assert.That(userAfter.MustChangePassword).IsEqualTo(userBefore.MustChangePassword);
        await Assert.That(await OrganizationIdAsync(fixture, member)).IsEqualTo(orgId);
        var projectAfter = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId);
        await Assert.That(projectAfter.DocumentJson).IsEqualTo(projectBefore.DocumentJson);
        await Assert.That(projectAfter.Revision).IsEqualTo(projectBefore.Revision);
        await Assert.That(await database.ProjectAssignments.CountAsync(row => row.ProjectId == projectId && row.UserId == member)).IsEqualTo(1);
        await AuthTestRequests.AssertSafeAsync(fixture, disabled);
    }

    [Test]
    [Arguments("anonymous", 401)]
    [Arguments(ApplicationRoles.Creator, 403)]
    [Arguments(ApplicationRoles.Educator, 403)]
    [Arguments("forced", 403)]
    [Arguments("disabled", 401)]
    public async Task OrganizationLifecycle_AllWritesRequireCurrentFullAdministrator(string actor, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var member = await fixture.CreateAccountAsync();
        var orgId = await OrganizationIdAsync(fixture, member);
        if (actor != "anonymous")
        {
            var id = await fixture.CreateAccountAsync(actor is "forced" or "disabled" ? ApplicationRoles.Administrator : actor,
                forced: actor == "forced");
            await fixture.SignInAsync(id, forgedRole: ApplicationRoles.Administrator);
            if (actor == "disabled")
            {
                await using var scope = fixture.Database.Services.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(row => row.Id == id)
                    .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
            }
        }
        using var rejected = await PatchAsync(fixture, orgId, false);
        await Assert.That((int)rejected.StatusCode).IsEqualTo(status);
        await using var check = fixture.Database.Services.CreateAsyncScope();
        await Assert.That((await check.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.SingleAsync(row => row.Id == orgId)).IsActive).IsTrue();
    }

    [Test]
    public async Task OrganizationLifecycle_InvalidOrMissingRequestsCannotChangeData()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var orgId = await OrganizationIdAsync(fixture, await fixture.CreateAccountAsync());
        foreach (var json in new[] { "{}", "{\"isActive\":null}", "{\"isActive\":false,\"name\":\"Changed\"}" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Patch, Path(orgId))
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var response = await fixture.Client.SendAsync(request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        using var noToken = await fixture.Client.PatchAsJsonAsync(Path(orgId), new { isActive = false });
        await AuthTestRequests.AssertProblemAsync(noToken, HttpStatusCode.BadRequest, "csrf_invalid");
        using var missing = await PatchAsync(fixture, Guid.NewGuid(), false);
        await AuthTestRequests.AssertProblemAsync(missing, HttpStatusCode.NotFound, "organization_not_found");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var organization = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.SingleAsync(row => row.Id == orgId);
        await Assert.That(organization.IsActive).IsTrue();
        await Assert.That(organization.Name).IsEqualTo("Synthetic organization");
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task OrganizationLifecycle_QueuedChangesReadLockedStateAndRecheckActor(bool revokeSecondActor)
    {
        var commit = new CommitPause();
        var locks = new LockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, locks)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var secondId = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        using var secondClient = fixture.CreateClient();
        await fixture.SignInAsync(secondId, secondClient);
        var orgId = await OrganizationIdAsync(fixture, await fixture.CreateAccountAsync());
        var firstToken = await fixture.GetCsrfAsync();
        var secondToken = await fixture.GetCsrfAsync(secondClient);
        commit.Armed = true;
        var first = PatchAsync(fixture, orgId, false, token: firstToken);
        Task<HttpResponseMessage>? second = null;
        try
        {
            var holder = await commit.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            locks.Armed = true;
            second = PatchAsync(fixture, orgId, true, secondClient, secondToken);
            var waiter = await locks.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, holder);
            if (revokeSecondActor)
            {
                await using var scope = fixture.Database.Services.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(row => row.Id == secondId)
                    .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
            }
            commit.Release.TrySetResult();
            using var winner = await first;
            using var queued = await second;
            await Assert.That(winner.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await Assert.That(queued.StatusCode).IsEqualTo(revokeSecondActor ? HttpStatusCode.Unauthorized : HttpStatusCode.NoContent);
            await using var check = fixture.Database.Services.CreateAsyncScope();
            await Assert.That((await check.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.SingleAsync(row => row.Id == orgId)).IsActive)
                .IsEqualTo(!revokeSecondActor);
        }
        finally
        {
            commit.Release.TrySetResult();
            using var drainedFirst = await first;
            if (second is not null) { using var drainedSecond = await second; }
        }
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task OrganizationLifecycle_FailureOrExpiryRollsBackTheStateChange(bool expires)
    {
        var commit = new AdministrationCommitInterceptor();
        var save = new SaveProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, save)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var orgId = await OrganizationIdAsync(fixture, await fixture.CreateAccountAsync());
        var token = await fixture.GetCsrfAsync();
        if (expires) { save.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9)); }
        else { commit.Arm(); }
        using var response = await PatchAsync(fixture, orgId, false, token: token);
        await Assert.That(response.StatusCode).IsEqualTo(expires ? HttpStatusCode.Unauthorized : HttpStatusCode.InternalServerError);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That((await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Organizations.SingleAsync(row => row.Id == orgId)).IsActive).IsTrue();
        await AuthTestRequests.AssertSafeAsync(fixture, response);
    }

    private static string Path(Guid id) => $"/api/admin/organizations/{id:D}/active";

    private static async Task<Guid> OrganizationIdAsync(HttpsApplicationFixture fixture, Guid userId)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().OrganizationMemberships
            .Where(row => row.UserId == userId).Select(row => row.OrganizationId).SingleAsync();
    }

    private static async Task<HttpResponseMessage> PatchAsync(HttpsApplicationFixture fixture, Guid id, bool active,
        HttpClient? client = null, string? token = null)
    {
        client ??= fixture.Client;
        using var request = new HttpRequestMessage(HttpMethod.Patch, Path(id)) { Content = JsonContent.Create(new { isActive = active }) };
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(request);
    }

    private static async Task WaitBlockedAsync(HttpsApplicationFixture fixture, int waiter, int holder)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var connection = (NpgsqlConnection)scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetDbConnection();
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("SELECT @holder = ANY(pg_blocking_pids(@waiter))", connection);
        command.Parameters.AddWithValue("waiter", waiter);
        command.Parameters.AddWithValue("holder", holder);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!(bool)(await command.ExecuteScalarAsync(timeout.Token) ?? false))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(10), timeout.Token);
        }
    }

    private sealed class CommitPause : DbTransactionInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed)
            {
                Armed = false;
                Entered.TrySetResult(((NpgsqlConnection)transaction.Connection!).ProcessID);
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }

    private sealed class LockProbe : DbCommandInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal))
            {
                Armed = false;
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }

    private sealed class SaveProbe : SaveChangesInterceptor
    {
        public Action? After;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }
}
