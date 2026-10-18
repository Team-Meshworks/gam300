using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class CredentialOperationTests
{
    private const string ResetPassword = "Concurrent administrator reset 3!";

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Login_ResetAfterPasswordVerification_RejectsUnverifiedNewStamp(bool rehashNeeded)
    {
        var barrier = new PasswordVerificationBarrier();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddSingleton<IPasswordHasher<ApplicationUser>>(barrier));
        var target = await fixture.CreateAccountAsync();
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(administrator);
        if (rehashNeeded)
        {
            await using var setup = fixture.Database.Services.CreateAsyncScope();
            var database = setup.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync(user => user.Id == target);
            user.PasswordHash = new PasswordHasher<ApplicationUser>(Options.Create(new PasswordHasherOptions { IterationCount = 1 }))
                .HashPassword(user, AuthTestRequests.CurrentPassword);
            await database.SaveChangesAsync();
        }
        var client = fixture.CreateClient();
        var token = await fixture.GetCsrfAsync(client);
        var name = await AuthTestRequests.UserNameAsync(fixture, target);
        barrier.Arm(target);
        var request = AuthTestRequests.PostAsync(fixture, "/api/auth/login", new
        {
            userName = name,
            password = AuthTestRequests.CurrentPassword,
        }, client, token);
        using var response = await DuringPauseAsync(request, barrier.Entered.Task, async () =>
        {
            using var reset = await ResetAsync(fixture, target);
            await Assert.That(reset.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }, () => barrier.Release.TrySetResult());
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "login_failed");
        await Assert.That(response.Headers.Contains("Set-Cookie")).IsFalse();
        await AssertResetWonAsync(fixture, target);
        using var session = await client.GetAsync("/api/auth/session");
        await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await AssertSafeAsync(fixture, response);
    }

    [Test]
    public async Task PasswordChange_OldTrackedActorAfterFiveMinutes_LosesToResetWithoutPartialState()
    {
        var gate = new PasswordChangeSaveGate();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)));
        var target = await fixture.CreateAccountAsync(forced: true);
        await fixture.SignInAsync(target);
        var administratorClient = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator), administratorClient);
        var token = await fixture.GetCsrfAsync();
        fixture.Clock.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
        gate.Arm(target);
        var request = AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = AuthTestRequests.NewPassword,
        }, token: token);
        using var response = await DuringPauseAsync(request, gate.Entered.Task, async () =>
        {
            using var reset = await ResetAsync(fixture, target, administratorClient);
            await Assert.That(reset.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }, () => gate.Release.TrySetResult());
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Conflict, "account_conflict");
        await AssertResetWonAsync(fixture, target);
        using var stale = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await AssertSafeAsync(fixture, response);
    }

    [Test]
    public async Task PasswordChange_ResetAfterCommitBeforeRefresh_AnyLateCookieIsStale()
    {
        var gate = new PrincipalCreationGate();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Host.ConfigureContainer<IServiceCollection>((_, collection) =>
            {
                collection.AddScoped<IUserClaimsPrincipalFactory<ApplicationUser>>(services => new PausingPrincipalFactory(
                    new UserClaimsPrincipalFactory<ApplicationUser, IdentityRole<Guid>>(
                        services.GetRequiredService<UserManager<ApplicationUser>>(), services.GetRequiredService<RoleManager<IdentityRole<Guid>>>(),
                        services.GetRequiredService<IOptions<IdentityOptions>>()), gate));
            });
        });
        await using (var verification = fixture.App.Services.CreateAsyncScope())
        {
            await Assert.That(verification.ServiceProvider.GetRequiredService<IUserClaimsPrincipalFactory<ApplicationUser>>()
                is PausingPrincipalFactory).IsTrue();
        }
        var target = await fixture.CreateAccountAsync(forced: true);
        await fixture.SignInAsync(target);
        var originalCutoff = fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey];
        var administratorClient = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator), administratorClient);
        var token = await fixture.GetCsrfAsync();
        gate.Arm(target);
        var request = AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = AuthTestRequests.NewPassword,
        }, token: token);
        using var response = await DuringPauseAsync(request, gate.Entered.Task, async () =>
        {
            await using (var observer = fixture.App.Services.CreateAsyncScope())
            {
                var manager = observer.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
                var user = await manager.FindByIdAsync(target.ToString("D")) ?? throw new InvalidOperationException("Missing committed target.");
                await Assert.That(user.MustChangePassword).IsFalse();
                await Assert.That(await manager.CheckPasswordAsync(user, AuthTestRequests.NewPassword)).IsTrue();
            }
            using var reset = await ResetAsync(fixture, target, administratorClient);
            await Assert.That(reset.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }, () => gate.Release.TrySetResult());
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]).IsEqualTo(originalCutoff);
        await AssertResetWonAsync(fixture, target);
        using var stale = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await AssertSafeAsync(fixture, response);
    }

    [Test]
    public async Task PasswordChange_CommitException_RollsBackHashStampFlagAndKeepsSession()
    {
        var interceptor = new AdministrationCommitInterceptor();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(interceptor)));
        var target = await fixture.CreateAccountAsync(forced: true);
        await fixture.SignInAsync(target);
        var before = await SnapshotAsync(fixture, target);
        interceptor.Arm();
        using var response = await AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = AuthTestRequests.NewPassword,
        });
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.InternalServerError, "internal_error");
        await Assert.That(await SnapshotAsync(fixture, target) == before).IsTrue();
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await AssertSafeAsync(fixture, response);
    }

    [Test]
    public async Task PasswordChange_CanceledUncommittedOperation_RollsBackBeforeAnyRefresh()
    {
        var interceptor = new AdministrationCommitInterceptor();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(interceptor)));
        var target = await fixture.CreateAccountAsync(forced: true);
        await fixture.SignInAsync(target);
        var before = await SnapshotAsync(fixture, target);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var accessor = scope.ServiceProvider.GetRequiredService<IHttpContextAccessor>();
        var previous = accessor.HttpContext;
        var context = new DefaultHttpContext { RequestServices = scope.ServiceProvider, User = fixture.ReadTicket().Principal };
        context.Request.Scheme = "https";
        context.Features.Set(await CurrentAccountAsync(fixture, target));
        accessor.HttpContext = context;
        using var cancellation = new CancellationTokenSource();
        interceptor.Arm(cancellation);
        try
        {
            var service = scope.ServiceProvider.GetRequiredService<AccountSessionService>();
            await Assert.ThrowsAsync<OperationCanceledException>(() => service.ChangePasswordAsync(new ChangePasswordRequest
            {
                CurrentPassword = AuthTestRequests.CurrentPassword,
                NewPassword = AuthTestRequests.NewPassword,
            }, cancellation.Token));
        }
        finally
        {
            accessor.HttpContext = previous;
        }
        await Assert.That(context.Response.Headers.ContainsKey("Set-Cookie")).IsFalse();
        await Assert.That(await SnapshotAsync(fixture, target) == before).IsTrue();
    }

    [Test]
    public async Task PasswordChange_LoadedNewStampAgainstOldClaim_FailsBeforePasswordMutation()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var target = await fixture.CreateAccountAsync(forced: true);
        await fixture.SignInAsync(target);
        var principal = fixture.ReadTicket().Principal;
        var current = await CurrentAccountAsync(fixture, target);
        var administratorClient = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator), administratorClient);
        using var reset = await ResetAsync(fixture, target, administratorClient);
        await Assert.That(reset.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var before = await SnapshotAsync(fixture, target);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var accessor = scope.ServiceProvider.GetRequiredService<IHttpContextAccessor>();
        var previous = accessor.HttpContext;
        var context = new DefaultHttpContext { RequestServices = scope.ServiceProvider, User = principal };
        context.Request.Scheme = "https";
        context.Features.Set(current);
        accessor.HttpContext = context;
        try
        {
            var result = await scope.ServiceProvider.GetRequiredService<AccountSessionService>().ChangePasswordAsync(new ChangePasswordRequest
            {
                CurrentPassword = ResetPassword,
                NewPassword = AuthTestRequests.NewPassword,
            });
            await Assert.That(result.Succeeded).IsFalse();
            await Assert.That(result.Errors.Single().Code).IsEqualTo("AuthenticationRequired");
        }
        finally
        {
            accessor.HttpContext = previous;
        }
        await Assert.That(await SnapshotAsync(fixture, target) == before).IsTrue();
        await AssertResetWonAsync(fixture, target);
    }

    private static async Task<HttpResponseMessage> DuringPauseAsync(Task<HttpResponseMessage> request, Task entered,
        Func<Task> action, Action release)
    {
        try
        {
            await entered.WaitAsync(TimeSpan.FromSeconds(15));
            await action();
        }
        catch
        {
            release();
            using var drained = await request;
            throw;
        }
        finally
        {
            release();
        }
        return await request;
    }

    private static async Task AssertSafeAsync(HttpsApplicationFixture fixture, HttpResponseMessage response)
    {
        await AuthTestRequests.AssertSafeAsync(fixture, response);
        await Assert.That((await response.Content.ReadAsStringAsync()).Contains(ResetPassword, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(ResetPassword, StringComparison.Ordinal)).IsFalse();
    }
    private static Task<HttpResponseMessage> ResetAsync(HttpsApplicationFixture fixture, Guid id, HttpClient? client = null)
        => AuthTestRequests.PostAsync(fixture, $"/api/admin/users/{id:D}/password", new { newTemporaryPassword = ResetPassword }, client);

    private static async Task<(string? Hash, string? Stamp, string? ConcurrencyStamp, bool Forced)> SnapshotAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var user = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.AsNoTracking().SingleAsync(user => user.Id == id);
        return (user.PasswordHash, user.SecurityStamp, user.ConcurrencyStamp, user.MustChangePassword);
    }

    private static async Task<CurrentAccount> CurrentAccountAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var user = await database.Users.SingleAsync(user => user.Id == id);
        var organization = await database.OrganizationMemberships.Where(member => member.UserId == id)
            .Select(member => member.OrganizationId).SingleAsync();
        return new CurrentAccount(id, user.UserName!, ApplicationRoles.Creator, organization, user.MustChangePassword);
    }

    private static async Task AssertResetWonAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing reset target.");
        await Assert.That(user.MustChangePassword).IsTrue();
        await Assert.That(await manager.CheckPasswordAsync(user, ResetPassword)).IsTrue();
        await Assert.That(await manager.CheckPasswordAsync(user, AuthTestRequests.CurrentPassword)).IsFalse();
        await Assert.That(await manager.CheckPasswordAsync(user, AuthTestRequests.NewPassword)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(ResetPassword, StringComparison.Ordinal)).IsFalse();
    }
}
