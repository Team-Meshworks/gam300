using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountProvisioningConcurrencyTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Provision_AndUsernameOverride_SerializeBeforeUserWrites(bool provisionFirst)
    {
        var probe = new RoleWriteProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var target = await fixture.CreateAccountAsync();
        var token = await fixture.GetCsrfAsync();
        await using var gateScope = fixture.Database.Services.CreateAsyncScope();
        var gate = gateScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var orgId = (await gate.OrganizationMemberships.SingleAsync(row => row.UserId == target)).OrganizationId;
        var originalName = await gate.Users.Where(row => row.Id == target).Select(row => row.UserName).SingleAsync();
        await using var transaction = await gate.Database.BeginTransactionAsync();
        await gate.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE");
        var blocker = ((NpgsqlConnection)gate.Database.GetDbConnection()).ProcessID;
        probe.Arm();

        Task<HttpResponseMessage> ProvisionAsync() => AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users", new
        {
            userName = "concurrent-account",
            initialPassword = AuthTestRequests.CurrentPassword,
            role = ApplicationRoles.Creator,
            orgId,
        }, token: token);
        async Task<HttpResponseMessage> RenameAsync()
        {
            using var request = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/admin/users/{target}")
            {
                Content = JsonContent.Create(new { userName = "CONCURRENT-ACCOUNT" }),
            };
            request.Headers.Add("X-CSRF-TOKEN", token);
            return await fixture.Client.SendAsync(request);
        }

        Task<HttpResponseMessage>? first = null;
        Task<HttpResponseMessage>? second = null;
        try
        {
            // Queue both real API transactions behind a third connection's role lock.
            // On the broken path provisioning inserts a user before joining this queue;
            // a rename queued first then waits on that user while holding the role lock.
            first = provisionFirst ? ProvisionAsync() : RenameAsync();
            await WaitBlockedAsync(fixture, await probe.First.Task.WaitAsync(TimeSpan.FromSeconds(10)), blocker);
            second = provisionFirst ? RenameAsync() : ProvisionAsync();
            await WaitBlockedAsync(fixture, await probe.Second.Task.WaitAsync(TimeSpan.FromSeconds(10)), blocker);
        }
        finally
        {
            await transaction.CommitAsync();
            // Drain requests even when a barrier assertion fails, before disposing their host.
            if (first is not null)
            {
                await first.WaitAsync(TimeSpan.FromSeconds(10));
            }

            if (second is not null)
            {
                await second.WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        using var winner = await first!;
        using var conflict = await second!;
        await Assert.That(winner.StatusCode).IsEqualTo(provisionFirst ? HttpStatusCode.Created : HttpStatusCode.OK);
        await AuthTestRequests.AssertProblemAsync(conflict, HttpStatusCode.Conflict, "username_taken");
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var stored = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var usernameOwner = await stored.Users.SingleAsync(row => row.NormalizedUserName == "CONCURRENT-ACCOUNT");
        await Assert.That(usernameOwner.Id == target).IsEqualTo(!provisionFirst);
        await Assert.That(await stored.Users.CountAsync()).IsEqualTo(provisionFirst ? 3 : 2);
        await Assert.That(await stored.UserRoles.CountAsync()).IsEqualTo(provisionFirst ? 3 : 2);
        await Assert.That(await stored.OrganizationMemberships.CountAsync()).IsEqualTo(provisionFirst ? 2 : 1);
        if (provisionFirst)
        {
            await Assert.That(await stored.Users.Where(row => row.Id == target).Select(row => row.UserName).SingleAsync()).IsEqualTo(originalName);
        }

        await Assert.That(fixture.Logs.Messages.Contains("40P01", StringComparison.Ordinal)).IsFalse();
    }

    private static async Task WaitBlockedAsync(HttpsApplicationFixture fixture, int waiter, int blocker)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var observer = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await observer.Database.SqlQuery<bool>($"SELECT {blocker} = ANY(pg_blocking_pids({waiter})) AS \"Value\"").SingleAsync(timeout.Token))
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class RoleWriteProbe : DbCommandInterceptor
    {
        private int _armed;
        private readonly HashSet<int> _connections = [];
        public TaskCompletionSource<int> First { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<int> Second { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        private void Observe(DbCommand command)
        {
            if (Volatile.Read(ref _armed) != 1
                || !(command.CommandText.StartsWith("LOCK TABLE \"AspNetUserRoles\"", StringComparison.Ordinal)
                    || command.CommandText.StartsWith("INSERT INTO \"AspNetUserRoles\"", StringComparison.Ordinal)))
            {
                return;
            }

            var processId = ((NpgsqlConnection)command.Connection!).ProcessID;
            lock (_connections)
            {
                if (!_connections.Add(processId))
                {
                    return;
                }

                if (_connections.Count == 1)
                {
                    First.TrySetResult(processId);
                }
                else
                {
                    Second.TrySetResult(processId);
                }
            }
        }
        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return ValueTask.FromResult(result);
        }
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return ValueTask.FromResult(result);
        }
    }
}
