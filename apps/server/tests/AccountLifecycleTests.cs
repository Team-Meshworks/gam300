using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountLifecycleTests
{
    [Test]
    public async Task AccountLifecycle_EnableDisablePreservesCredentialsAndInvalidatesCapturedSessions()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var target = await fixture.CreateAccountAsync(forced: true);
        var cookies = new CookieContainer();
        using var targetClient = fixture.CreateClient(cookies);
        await fixture.SignInAsync(target, targetClient);
        var captured = cookies.GetCookies(fixture.Address)[HttpsApplicationFixture.CookieName]!.Value;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(row => row.Id == target)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.AccessFailedCount, 2)
                    .SetProperty(row => row.LockoutEnd, DateTimeOffset.UtcNow.AddHours(1)));
        }
        var before = await ReadUserAsync(fixture, target);
        using var disabled = await PatchAsync(fixture, target, false);
        await Assert.That(disabled.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var afterDisable = await ReadUserAsync(fixture, target);
        await Assert.That(afterDisable.IsActive).IsFalse();
        await Assert.That(afterDisable.SecurityStamp != before.SecurityStamp).IsTrue();
        await Assert.That(afterDisable.ConcurrencyStamp != before.ConcurrencyStamp).IsTrue();
        using var lostAccess = await targetClient.GetAsync("/api/auth/session");
        await Assert.That(lostAccess.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        using var again = await PatchAsync(fixture, target, false);
        await Assert.That(again.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var afterRepeat = await ReadUserAsync(fixture, target);
        await Assert.That(afterRepeat.SecurityStamp).IsEqualTo(afterDisable.SecurityStamp);
        await Assert.That(afterRepeat.ConcurrencyStamp).IsEqualTo(afterDisable.ConcurrencyStamp);
        using var enabled = await PatchAsync(fixture, target, true);
        await Assert.That(enabled.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var after = await ReadUserAsync(fixture, target);
        await Assert.That(after.IsActive).IsTrue();
        await Assert.That(after.SecurityStamp).IsEqualTo(afterDisable.SecurityStamp);
        await Assert.That(after.PasswordHash).IsEqualTo(before.PasswordHash);
        await Assert.That(after.UserName).IsEqualTo(before.UserName);
        await Assert.That(after.NormalizedUserName).IsEqualTo(before.NormalizedUserName);
        await Assert.That(after.MustChangePassword).IsEqualTo(before.MustChangePassword);
        await Assert.That(after.AccessFailedCount).IsEqualTo(before.AccessFailedCount);
        await Assert.That(after.LockoutEnd).IsEqualTo(before.LockoutEnd);
        await Assert.That(after.LockoutEnabled).IsEqualTo(before.LockoutEnabled);
        var replayCookies = new CookieContainer();
        replayCookies.Add(fixture.Address, new Cookie(HttpsApplicationFixture.CookieName, captured, "/") { Secure = true });
        using var replay = fixture.CreateClient(replayCookies);
        using var oldCookie = await replay.GetAsync("/api/auth/session");
        await Assert.That(oldCookie.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await using var check = fixture.Database.Services.CreateAsyncScope();
        var database = check.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await database.UserRoles.SingleAsync(row => row.UserId == target)).RoleId).IsEqualTo(ApplicationRoles.CreatorId);
        await Assert.That((await database.OrganizationMemberships.SingleAsync(row => row.UserId == target)).RoleId).IsEqualTo(ApplicationRoles.CreatorId);
        await AuthTestRequests.AssertSafeAsync(fixture, disabled);
        await AuthTestRequests.AssertSafeAsync(fixture, enabled);
    }

    [Test]
    [Arguments("anonymous", 401)]
    [Arguments(ApplicationRoles.Creator, 403)]
    [Arguments(ApplicationRoles.Educator, 403)]
    [Arguments("forced", 403)]
    [Arguments("disabled", 401)]
    public async Task AccountLifecycle_OnlyCurrentFullAdministratorCanChangeState(string actor, int status)
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
        using var response = await PatchAsync(fixture, target, false);
        await Assert.That((int)response.StatusCode).IsEqualTo(status);
        await Assert.That((await ReadUserAsync(fixture, target)).IsActive).IsTrue();
    }

    [Test]
    public async Task AccountLifecycle_StrictBooleanBodyAndCsrfAreRequired()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var target = await fixture.CreateAccountAsync();
        var before = await ReadUserAsync(fixture, target);
        foreach (var json in new[] { "{}", "{\"isActive\":null}", "{\"isActive\":\"false\"}", "{\"isActive\":0}",
            "{\"IsActive\":false}", "{\"isActive\":false,\"isActive\":true}", "{\"isActive\":false,\"role\":\"Administrator\"}" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Patch, Path(target))
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var rejected = await fixture.Client.SendAsync(request);
            await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        using var noToken = await fixture.Client.PatchAsJsonAsync(Path(target), new { isActive = false });
        await AuthTestRequests.AssertProblemAsync(noToken, HttpStatusCode.BadRequest, "csrf_invalid");
        var after = await ReadUserAsync(fixture, target);
        await Assert.That(after.IsActive).IsTrue();
        await Assert.That(after.SecurityStamp).IsEqualTo(before.SecurityStamp);
        using var missing = await PatchAsync(fixture, Guid.NewGuid(), false);
        await AuthTestRequests.AssertProblemAsync(missing, HttpStatusCode.NotFound, "account_not_found");
    }

    [Test]
    public async Task AccountLifecycle_LastActiveAdministratorCannotBeDisabled()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var other = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(actor);
        using var inactive = await PatchAsync(fixture, other, false);
        await Assert.That(inactive.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var before = await ReadUserAsync(fixture, actor);
        using var blocked = await PatchAsync(fixture, actor, false);
        await AuthTestRequests.AssertProblemAsync(blocked, HttpStatusCode.Conflict, "last_administrator");
        using var unchanged = await PatchAsync(fixture, actor, true);
        await Assert.That(unchanged.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var after = await ReadUserAsync(fixture, actor);
        await Assert.That(after.IsActive).IsTrue();
        await Assert.That(after.SecurityStamp).IsEqualTo(before.SecurityStamp);
        await Assert.That(after.ConcurrencyStamp).IsEqualTo(before.ConcurrencyStamp);
    }

    [Test]
    public async Task AccountLifecycle_ConcurrentSelfDisablesSerializeAndKeepOneAdministrator()
    {
        var commit = new CommitPause();
        var locks = new LockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, locks)));
        var firstId = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var secondId = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(firstId);
        using var secondClient = fixture.CreateClient();
        await fixture.SignInAsync(secondId, secondClient);
        var firstToken = await fixture.GetCsrfAsync();
        var secondToken = await fixture.GetCsrfAsync(secondClient);
        commit.Armed = true;
        var first = PatchAsync(fixture, firstId, false, token: firstToken);
        Task<HttpResponseMessage>? second = null;
        try
        {
            var holder = await commit.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            locks.Armed = true;
            second = PatchAsync(fixture, secondId, false, secondClient, secondToken);
            var waiter = await locks.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, holder);
            commit.Release.TrySetResult();
            using var winner = await first;
            using var loser = await second;
            await Assert.That(winner.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await AuthTestRequests.AssertProblemAsync(loser, HttpStatusCode.Conflict, "last_administrator");
            await Assert.That((await ReadUserAsync(fixture, firstId)).IsActive).IsFalse();
            await Assert.That((await ReadUserAsync(fixture, secondId)).IsActive).IsTrue();
            using var retained = await secondClient.GetAsync("/api/admin/users");
            await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
        }
        finally
        {
            commit.Release.TrySetResult();
            using var drainedFirst = await first;
            if (second is not null) { using var drainedSecond = await second; }
        }
    }

    [Test]
    public async Task AccountLifecycle_ActorIsRevalidatedAfterWaitingForLifecycleLock()
    {
        var locks = new LockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(locks)));
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var target = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync();
        await database.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE");
        var holder = ((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID;
        locks.Armed = true;
        var pending = PatchAsync(fixture, target, false, token: token);
        try
        {
            var waiter = await locks.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, holder);
            await database.Users.Where(row => row.Id == actor).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
            await transaction.CommitAsync();
            using var response = await pending;
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
            await Assert.That((await ReadUserAsync(fixture, target)).IsActive).IsTrue();
        }
        finally
        {
            await transaction.DisposeAsync();
            using var drained = await pending;
        }
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task AccountLifecycle_FailedCommitOrExpiredSessionRollsBackStateAndStamp(bool expires)
    {
        var commit = new AdministrationCommitInterceptor();
        var save = new SaveProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, save)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var target = await fixture.CreateAccountAsync();
        var before = await ReadUserAsync(fixture, target);
        var token = await fixture.GetCsrfAsync();
        if (expires) { save.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9)); }
        else { commit.Arm(); }
        using var response = await PatchAsync(fixture, target, false, token: token);
        await Assert.That(response.StatusCode).IsEqualTo(expires ? HttpStatusCode.Unauthorized : HttpStatusCode.InternalServerError);
        var after = await ReadUserAsync(fixture, target);
        await Assert.That(after.IsActive).IsTrue();
        await Assert.That(after.SecurityStamp).IsEqualTo(before.SecurityStamp);
        await Assert.That(after.ConcurrencyStamp).IsEqualTo(before.ConcurrencyStamp);
        await AuthTestRequests.AssertSafeAsync(fixture, response);
    }

    private static string Path(Guid id) => $"/api/admin/users/{id:D}/active";

    private static async Task<HttpResponseMessage> PatchAsync(HttpsApplicationFixture fixture, Guid id, bool active,
        HttpClient? client = null, string? token = null)
    {
        client ??= fixture.Client;
        using var request = new HttpRequestMessage(HttpMethod.Patch, Path(id)) { Content = JsonContent.Create(new { isActive = active }) };
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(request);
    }

    private static async Task<ApplicationUser> ReadUserAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.AsNoTracking().SingleAsync(row => row.Id == id);
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
        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("LOCK TABLE \"AspNetUserRoles\"", StringComparison.Ordinal))
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
