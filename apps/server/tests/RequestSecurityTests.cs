using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class RequestSecurityTests
{
    [Test]
    public async Task Cookie_NonPersistentSecureHttpOnlyLax_WithAbsoluteEightHourMarker()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var start = fixture.Clock.GetUtcNow();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var ticket = fixture.ReadTicket();
        await Assert.That(ticket.Properties.IsPersistent).IsFalse();
        await Assert.That(long.Parse(ticket.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!, CultureInfo.InvariantCulture))
            .IsEqualTo(start.AddHours(8).UtcTicks);
        await Assert.That(fixture.SignInCookieHeaders.Any(header => header.StartsWith(HttpsApplicationFixture.CookieName + "=", StringComparison.Ordinal)
            && header.Contains("secure", StringComparison.OrdinalIgnoreCase)
            && header.Contains("httponly", StringComparison.OrdinalIgnoreCase)
            && header.Contains("samesite=lax", StringComparison.OrdinalIgnoreCase)
            && !header.Contains("expires=", StringComparison.OrdinalIgnoreCase)
            && !header.Contains("max-age=", StringComparison.OrdinalIgnoreCase))).IsTrue();
        var options = fixture.App.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
            .Get(IdentityConstants.ApplicationScheme);
        await Assert.That(options.SlidingExpiration).IsFalse();
        await Assert.That(options.ExpireTimeSpan).IsEqualTo(TimeSpan.FromHours(8));
    }

    [Test]
    public async Task Cookie_StandardStampRenewal_PreservesMarkerAndRejectsExactOriginalCutoff()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var initial = fixture.ReadTicket();
        var cutoff = initial.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey];
        fixture.Clock.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
        fixture.Clock.AdvanceOnRead(TimeSpan.FromSeconds(1));
        using var renewed = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(renewed.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var renewedTicket = fixture.ReadTicket();
        await Assert.That(renewedTicket.Properties.IssuedUtc > initial.Properties.IssuedUtc).IsTrue();
        await Assert.That(renewedTicket.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey] == cutoff).IsTrue();
        var originalCutoff = new DateTimeOffset(long.Parse(cutoff!, CultureInfo.InvariantCulture), TimeSpan.Zero);
        await Assert.That(renewedTicket.Properties.ExpiresUtc > originalCutoff).IsTrue();
        fixture.Clock.AdvanceOnRead(TimeSpan.Zero);
        fixture.Clock.Set(originalCutoff);
        using var expired = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(expired.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
    }

    [Test]
    [Arguments("missing")]
    [Arguments("malformed")]
    public async Task Cookie_InvalidProtectedCutoff_IsRejected(string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var ticket = fixture.ReadTicket();
        if (scenario == "missing")
        {
            ticket.Properties.Items.Remove(HttpsApplicationFixture.AbsoluteExpiryKey);
        }
        else
        {
            ticket.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey] = "invalid";
        }
        fixture.ReplaceTicket(ticket);
        using var response = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
    }

    [Test]
    public async Task Csrf_AnonymousBootstrapAndChangedPrincipal_RequireRefreshedHeaderToken()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var anonymousToken = await fixture.GetCsrfAsync();
        using (var noToken = await fixture.Client.PostAsJsonAsync("/_test/anonymous-write", new { value = "synthetic" }))
        {
            await Assert.That(noToken.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        using (var anonymous = CreateWrite("/_test/anonymous-write", anonymousToken))
        using (var accepted = await fixture.Client.SendAsync(anonymous))
        {
            await Assert.That(accepted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using (var stale = CreateWrite("/_test/write", anonymousToken))
        using (var rejected = await fixture.Client.SendAsync(stale))
        {
            await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        await Assert.That(fixture.Writes).IsEqualTo(0);
        using var valid = CreateWrite("/_test/write", await fixture.GetCsrfAsync());
        using var response = await fixture.Client.SendAsync(valid);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(fixture.Writes).IsEqualTo(1);
    }

    [Test]
    public async Task Csrf_TokenFromDifferentPrincipalWithSameAntiforgeryCookie_IsRejected()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        await fixture.GetCsrfAsync();
        var otherCookies = new CookieContainer();
        var other = fixture.CreateClient(otherCookies);
        await fixture.SignInAsync(await fixture.CreateAccountAsync(), other);
        var originalCookie = fixture.Cookies.GetCookies(fixture.Address)["__Host-Spatia.Antiforgery"]
            ?? throw new InvalidOperationException("Expected an antiforgery cookie.");
        otherCookies.Add(fixture.Address, new Cookie(originalCookie.Name, originalCookie.Value, "/") { Secure = true, HttpOnly = true });
        var otherToken = await fixture.GetCsrfAsync(other);
        using var request = CreateWrite("/_test/write", otherToken);
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await Assert.That(fixture.Writes).IsEqualTo(0);
    }

    [Test]
    [Arguments("missing")]
    [Arguments("multiple")]
    [Arguments("form-only")]
    public async Task Csrf_MissingAmbiguousOrFormOnlyHeader_NeverInvokesJsonWrite(string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var token = await fixture.GetCsrfAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/_test/write");
        if (scenario == "multiple")
        {
            request.Headers.Add("X-CSRF-TOKEN", new[] { token, token });
        }
        request.Content = scenario == "form-only"
            ? new FormUrlEncodedContent(new Dictionary<string, string> { ["__RequestVerificationToken"] = token })
            : JsonContent.Create(new { secret = HttpsApplicationFixture.SecretSentinel });
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await Assert.That(fixture.Writes).IsEqualTo(0);
    }

    [Test]
    public async Task DataProtection_AppRestartWithRetainedKeys_AcceptsExistingCookie()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var keys = Directory.GetFiles(fixture.KeyDirectory, "key-*.xml");
        await Assert.That(keys.Length > 0).IsTrue();
        await fixture.RestartAsync();
        using var response = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(keys.All(File.Exists)).IsTrue();
    }

    [Test]
    public async Task Browser_RealCsrfBootstrapRefreshAndJsonWrite_EnforceCookieBoundary()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        var start = new ProcessStartInfo("node") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        var serverDirectory = Path.GetFullPath("../../../../", AppContext.BaseDirectory);
        start.WorkingDirectory = serverDirectory;
        start.ArgumentList.Add(Path.Combine(serverDirectory, "tests/csrf-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(id.ToString("D"));
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the existing browser check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch
        {
            process.Kill(true);
            throw;
        }
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException("Browser boundary check failed: " + await error);
        }
        var browserOutput = await output;
        await Assert.That(browserOutput.Contains("browser csrf boundary passed", StringComparison.Ordinal)).IsTrue();
        await File.WriteAllTextAsync(Path.Combine(serverDirectory, ".artifacts/scrum45-browser-version.txt"), browserOutput);
        await Assert.That(string.IsNullOrWhiteSpace(await error)).IsTrue();
        await Assert.That(fixture.Writes).IsEqualTo(1);
    }

    [Test]
    public async Task Cookie_DatabaseQueryCrossesOriginalCutoff_RequestIsRejectedAfterQuery()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        fixture.Clock.Advance(TimeSpan.FromHours(8) - TimeSpan.FromMinutes(1));
        await using var lockingScope = fixture.Database.Services.CreateAsyncScope();
        var lockingDatabase = lockingScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await lockingDatabase.Database.BeginTransactionAsync();
        await lockingDatabase.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUsers\" IN ACCESS EXCLUSIVE MODE");
        var request = fixture.Client.GetAsync("/_test/probe");
        var released = false;
        try
        {
            await using var observerScope = fixture.Database.Services.CreateAsyncScope();
            var connection = (NpgsqlConnection)observerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>()
                .Database.GetDbConnection();
            await connection.OpenAsync();
            await using var blocked = new NpgsqlCommand("SELECT count(*) FROM pg_stat_activity WHERE application_name = @name AND wait_event_type = 'Lock'", connection);
            blocked.Parameters.AddWithValue("name", "Spatia.Part3." + fixture.Database.SchemaName);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((long)(await blocked.ExecuteScalarAsync(timeout.Token) ?? 0L) == 0)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(10), timeout.Token);
            }
            fixture.Clock.Advance(TimeSpan.FromMinutes(1));
            await transaction.CommitAsync();
            released = true;
        }
        finally
        {
            if (!released)
            {
                await transaction.RollbackAsync();
            }
        }
        using var response = await request;
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
    }

    [Test]
    [Arguments(11, false)]
    [Arguments(12, true)]
    [Arguments(128, true)]
    [Arguments(129, false)]
    public async Task PasswordValidators_ActualHostComposition_EnforceAdoptedLengthBounds(int length, bool valid)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser { Id = Guid.NewGuid(), UserName = "validation-only" };
        var result = await manager.CreateAsync(user, new string('a', length));
        await Assert.That(result.Succeeded).IsEqualTo(valid);
        if (valid)
        {
            await Assert.That(user.LockoutEnabled).IsTrue();
        }
        var options = scope.ServiceProvider.GetRequiredService<IOptions<IdentityOptions>>().Value;
        await Assert.That(options.Lockout.MaxFailedAccessAttempts).IsEqualTo(5);
        await Assert.That(options.Lockout.DefaultLockoutTimeSpan).IsEqualTo(TimeSpan.FromMinutes(5));
    }
    internal static HttpRequestMessage CreateWrite(string path, string token)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(new { value = "synthetic" }) };
        request.Headers.Add("X-CSRF-TOKEN", token);
        return request;
    }
}
