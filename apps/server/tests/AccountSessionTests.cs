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
public sealed class AccountSessionTests
{
    [Test]
    [Arguments(ApplicationRoles.Administrator, false)]
    [Arguments(ApplicationRoles.Educator, false)]
    [Arguments(ApplicationRoles.Creator, true)]
    public async Task LoginAndSession_UseCurrentAccountMetadataAndBoundedCookie(string role, bool forced)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync(role, forced);
        var name = await AuthTestRequests.UserNameAsync(fixture, id);
        var start = fixture.Clock.GetUtcNow();
        using var response = await LoginAsync(fixture, name);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That((await response.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
        var cookieHeaders = response.Headers.GetValues("Set-Cookie").ToArray();
        await Assert.That(cookieHeaders.Any(header => header.StartsWith(HttpsApplicationFixture.CookieName + "=", StringComparison.Ordinal)
            && header.Contains("secure", StringComparison.OrdinalIgnoreCase) && header.Contains("httponly", StringComparison.OrdinalIgnoreCase)
            && header.Contains("samesite=lax", StringComparison.OrdinalIgnoreCase) && !header.Contains("expires=", StringComparison.OrdinalIgnoreCase)
            && !header.Contains("max-age=", StringComparison.OrdinalIgnoreCase))).IsTrue();
        var ticket = fixture.ReadTicket();
        await Assert.That(ticket.Properties.IsPersistent).IsFalse();
        await Assert.That(ticket.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey])
            .IsEqualTo(start.AddHours(8).UtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture));
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var json = await session.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(json.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(
            new[] { "displayName", "mustChangePassword", "orgId", "role", "userId" })).IsTrue();
        await Assert.That(json.GetProperty("userId").GetGuid()).IsEqualTo(id);
        await Assert.That(json.GetProperty("displayName").GetString()).IsEqualTo(name);
        await Assert.That(json.GetProperty("role").GetString()).IsEqualTo(role);
        await Assert.That(json.GetProperty("mustChangePassword").GetBoolean()).IsEqualTo(forced);
        await Assert.That(json.GetProperty("orgId").ValueKind == JsonValueKind.Null).IsEqualTo(role == ApplicationRoles.Administrator);
        if (role != ApplicationRoles.Administrator)
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var organization = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().OrganizationMemberships
                .Where(member => member.UserId == id).Select(member => member.OrganizationId).SingleAsync();
            await Assert.That(json.GetProperty("orgId").GetGuid()).IsEqualTo(organization);
        }
        await Assert.That(session.Headers.CacheControl?.NoStore == true).IsTrue();
        await AuthTestRequests.AssertSafeAsync(fixture, session);
    }

    [Test]
    [Arguments("unknown")]
    [Arguments("wrong-password")]
    [Arguments("inactive")]
    [Arguments("locked")]
    [Arguments("missing-role")]
    [Arguments("missing-membership")]
    [Arguments("inactive-organization")]
    [Arguments("two-factor")]
    public async Task Login_ValidShapeCredentialAndAccountFailures_AreIndistinguishable401(string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        var name = await AuthTestRequests.UserNameAsync(fixture, id);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync();
            switch (scenario)
            {
                case "inactive": user.IsActive = false; break;
                case "locked": user.LockoutEnd = DateTimeOffset.UtcNow.AddMinutes(5); break;
                case "two-factor": user.TwoFactorEnabled = true; break;
                case "missing-role":
                    await database.OrganizationMemberships.ExecuteDeleteAsync();
                    await database.UserRoles.ExecuteDeleteAsync();
                    break;
                case "missing-membership": await database.OrganizationMemberships.ExecuteDeleteAsync(); break;
                case "inactive-organization":
                    await database.Organizations.ExecuteUpdateAsync(setters => setters.SetProperty(organization => organization.IsActive, false));
                    break;
            }
            await database.SaveChangesAsync();
        }
        using var response = await LoginAsync(fixture, scenario == "unknown" ? "unknown-account" : name,
            scenario == "wrong-password" ? AuthTestRequests.NewPassword : AuthTestRequests.CurrentPassword);
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "login_failed");
        var failure = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(failure.GetProperty("title").GetString()).IsEqualTo("The sign-in details could not be accepted.");
        await Assert.That(!failure.TryGetProperty("detail", out var detail) || detail.ValueKind == JsonValueKind.Null).IsTrue();
        await Assert.That(response.Headers.Contains("Set-Cookie")).IsFalse();
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await AuthTestRequests.AssertSafeAsync(fixture, response);
    }

    [Test]
    public async Task Login_FiveFailuresPersistLockout_ThenPastLockoutAllowsCorrectPassword()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        var name = await AuthTestRequests.UserNameAsync(fixture, id);
        var before = DateTimeOffset.UtcNow;
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            using var response = await LoginAsync(fixture, name, AuthTestRequests.NewPassword);
            await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "login_failed");
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var user = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync();
            await Assert.That(user.AccessFailedCount).IsEqualTo(attempt == 5 ? 0 : attempt);
            if (attempt == 5)
            {
                await Assert.That(user.LockoutEnd >= before.AddMinutes(5)
                    && user.LockoutEnd <= DateTimeOffset.UtcNow.AddMinutes(5)).IsTrue();
            }
        }
        using var whileLocked = await LoginAsync(fixture, name);
        await AuthTestRequests.AssertProblemAsync(whileLocked, HttpStatusCode.Unauthorized, "login_failed");
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(user => user.Id == id)
                .ExecuteUpdateAsync(setters => setters.SetProperty(user => user.LockoutEnd, DateTimeOffset.UtcNow.AddSeconds(-1)));
        }
        using var after = await LoginAsync(fixture, name);
        await Assert.That(after.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await using var reopened = fixture.Database.Services.CreateAsyncScope();
        await Assert.That((await reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync()).AccessFailedCount).IsEqualTo(0);
    }

    [Test]
    [Arguments(11, false)]
    [Arguments(12, true)]
    [Arguments(128, true)]
    [Arguments(129, false)]
    public async Task Login_PasswordBounds_AreCheckedBeforeCredentialWork(int length, bool validShape)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        using var response = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, id), new string('a', length));
        await AuthTestRequests.AssertProblemAsync(response, validShape ? HttpStatusCode.Unauthorized : HttpStatusCode.BadRequest,
            validShape ? "login_failed" : "invalid_login_input");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That((await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync()).AccessFailedCount)
            .IsEqualTo(validShape ? 1 : 0);
    }

    [Test]
    [Arguments("")]
    [Arguments(" ")]
    [Arguments("nul\0name")]
    [Arguments("oversized")]
    public async Task Login_InvalidUsernameBoundsOrNul_Is400(string name)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var response = await LoginAsync(fixture, name == "oversized" ? new string('a', 257) : name);
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.BadRequest, "invalid_login_input");
    }

    [Test]
    [Arguments("login", "unknown")]
    [Arguments("login", "duplicate")]
    [Arguments("login", "wrongcase")]
    [Arguments("login", "missing")]
    [Arguments("login", "null")]
    [Arguments("password", "unknown")]
    [Arguments("password", "duplicate")]
    [Arguments("password", "wrongcase")]
    [Arguments("password", "missing")]
    [Arguments("password", "null")]
    public async Task AuthJson_RejectsAmbiguousOrIncompleteShape(string operation, string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        var name = await AuthTestRequests.UserNameAsync(fixture, id);
        if (operation == "password")
        {
            using var login = await LoginAsync(fixture, name);
            await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        var key = operation == "login" ? "userName" : "currentPassword";
        var first = JsonSerializer.Serialize(key) + ":" + JsonSerializer.Serialize(operation == "login" ? name : AuthTestRequests.CurrentPassword);
        var tail = operation == "login" ? ",\"password\":" + JsonSerializer.Serialize(AuthTestRequests.CurrentPassword)
            : ",\"newPassword\":" + JsonSerializer.Serialize(AuthTestRequests.NewPassword);
        var json = scenario switch
        {
            "unknown" => "{" + first + tail + ",\"extra\":true}",
            "duplicate" => "{" + first + "," + first + tail + "}",
            "wrongcase" => "{" + first.Replace(key, key.ToUpperInvariant(), StringComparison.Ordinal) + tail + "}",
            "missing" => "{" + tail[1..] + "}",
            _ => "{" + JsonSerializer.Serialize(key) + ":null" + tail + "}",
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/" + operation)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That((await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync()).MustChangePassword).IsFalse();
        await AuthTestRequests.AssertSafeAsync(fixture, response);
    }

    [Test]
    public async Task PasswordChange_ForcedSession_CommitsAndRefreshesWithoutExtendingOriginalCutoff()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync(forced: true);
        var start = fixture.Clock.GetUtcNow();
        using var login = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, id));
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var original = fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey];
        var oldCookies = new CookieContainer();
        var originalCookie = fixture.Cookies.GetCookies(fixture.Address)[HttpsApplicationFixture.CookieName]!;
        oldCookies.Add(fixture.Address, new Cookie(originalCookie.Name, originalCookie.Value, "/") { Secure = true });
        var oldClient = fixture.CreateClient(oldCookies);
        fixture.Clock.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
        using var renewed = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(renewed.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]).IsEqualTo(original);
        fixture.Clock.Set(start.AddHours(8).AddMinutes(-1));
        using var changed = await AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = AuthTestRequests.NewPassword,
        });
        await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]).IsEqualTo(original);
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That((await session.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mustChangePassword").GetBoolean()).IsFalse();
        using var ordinary = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(ordinary.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var stale = await oldClient.GetAsync("/api/auth/session");
        await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing changed account.");
            await Assert.That(await manager.CheckPasswordAsync(user, AuthTestRequests.NewPassword)).IsTrue();
            await Assert.That(await manager.CheckPasswordAsync(user, AuthTestRequests.CurrentPassword)).IsFalse();
            await Assert.That(user.MustChangePassword).IsFalse();
        }
        fixture.Clock.Set(start.AddHours(8));
        using var expired = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(expired.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
    }

    [Test]
    [Arguments("wrong-current")]
    [Arguments("same")]
    [Arguments("short")]
    [Arguments("long")]
    public async Task PasswordChange_FailurePreservesPasswordStampForcedStateAndSession(string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync(forced: true);
        using var login = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, id));
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var ticket = fixture.ReadTicket();
        string stamp;
        string hash;
        await using (var before = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await before.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync();
            stamp = user.SecurityStamp!;
            hash = user.PasswordHash!;
        }
        using var response = await AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = scenario == "wrong-current" ? "Wrong synthetic password!" : AuthTestRequests.CurrentPassword,
            newPassword = scenario == "same" ? AuthTestRequests.CurrentPassword : scenario == "short" ? new string('a', 11)
                : scenario == "long" ? new string('a', 129) : AuthTestRequests.NewPassword,
        });
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.BadRequest, "password_change_failed");
        await using (var after = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await after.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync();
            await Assert.That(user.SecurityStamp == stamp && user.PasswordHash == hash).IsTrue();
            await Assert.That(user.MustChangePassword).IsTrue();
            await Assert.That(user.AccessFailedCount).IsEqualTo(0);
        }
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey])
            .IsEqualTo(ticket.Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]);
        await AuthTestRequests.AssertSafeAsync(fixture, response);
    }

    [Test]
    [Arguments(12)]
    [Arguments(128)]
    public async Task PasswordChange_ValidReplacementLengthNeedsNoComposition(int length)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync(forced: true);
        using var login = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, id));
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var replacement = new string('a', length);
        using var response = await AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = replacement,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = await manager.FindByIdAsync(id.ToString("D")) ?? throw new InvalidOperationException("Missing changed account.");
        await Assert.That(await manager.CheckPasswordAsync(user, replacement)).IsTrue();
    }

    [Test]
    public async Task PasswordChange_WhitespaceRemainsPartOfCredential()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        var name = await AuthTestRequests.UserNameAsync(fixture, id);
        using var login = await LoginAsync(fixture, name);
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        const string replacement = "  preserved password  ";
        using var response = await AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = replacement,
        });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var logout = await AuthTestRequests.PostAsync(fixture, "/api/auth/logout", null);
        await Assert.That(logout.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var trimmed = await LoginAsync(fixture, name, replacement.Trim());
        await AuthTestRequests.AssertProblemAsync(trimmed, HttpStatusCode.Unauthorized, "login_failed");
        using var unchanged = await LoginAsync(fixture, name, replacement);
        await Assert.That(unchanged.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
    }

    [Test]
    public async Task ForcedSession_RejectsAccountSwitchAndAllowsLogout()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var forced = await fixture.CreateAccountAsync(forced: true);
        var other = await fixture.CreateAccountAsync();
        using var first = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, forced));
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var switchAttempt = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, other));
        await AuthTestRequests.AssertProblemAsync(switchAttempt, HttpStatusCode.Forbidden, "access_denied");
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That((await session.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid()).IsEqualTo(forced);
        using var ordinary = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(ordinary.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var logout = await AuthTestRequests.PostAsync(fixture, "/api/auth/logout", null);
        await Assert.That(logout.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var gone = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(gone.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
    }

    [Test]
    public async Task FullSession_AccountSwitchUsesActorCsrf_FailedSwitchPreservesActor()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var first = await fixture.CreateAccountAsync();
        var second = await fixture.CreateAccountAsync();
        using var login = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, first));
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var oldToken = await fixture.GetCsrfAsync();
        using var failed = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, second), AuthTestRequests.NewPassword, oldToken);
        await AuthTestRequests.AssertProblemAsync(failed, HttpStatusCode.Unauthorized, "login_failed");
        using (var stillFirst = await fixture.Client.GetAsync("/api/auth/session"))
        {
            await Assert.That((await stillFirst.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid()).IsEqualTo(first);
        }
        using var switched = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, second), token: oldToken);
        await Assert.That(switched.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var stale = await AuthTestRequests.PostAsync(fixture, "/api/auth/password", new
        {
            currentPassword = AuthTestRequests.CurrentPassword,
            newPassword = AuthTestRequests.NewPassword,
        }, token: oldToken);
        await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That((await session.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid()).IsEqualTo(second);
        using var logout = await AuthTestRequests.PostAsync(fixture, "/api/auth/logout", null);
        await Assert.That(logout.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var anonymousOldToken = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, first), token: oldToken);
        await Assert.That(anonymousOldToken.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var fresh = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, first));
        await Assert.That(fresh.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
    }

    [Test]
    [Arguments("login")]
    [Arguments("password")]
    [Arguments("logout")]
    public async Task AuthWrites_MissingCsrf_NeverChangeAccountOrSession(string operation)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        var name = await AuthTestRequests.UserNameAsync(fixture, id);
        if (operation != "login")
        {
            using var login = await LoginAsync(fixture, name);
            await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        var before = await SnapshotAsync(fixture, id);
        using var response = await fixture.Client.PostAsJsonAsync("/api/auth/" + operation,
            operation == "login" ? (object)new { userName = name, password = AuthTestRequests.CurrentPassword }
                : new { currentPassword = AuthTestRequests.CurrentPassword, newPassword = AuthTestRequests.NewPassword });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await Assert.That(await SnapshotAsync(fixture, id) == before).IsTrue();
        using var session = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(session.StatusCode).IsEqualTo(operation == "login" ? HttpStatusCode.Unauthorized : HttpStatusCode.OK);
    }

    [Test]
    public async Task Logout_RequiresCurrentAccountAndDeletesCookieWithoutRevokingCopiedTicket()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var anonymous = await AuthTestRequests.PostAsync(fixture, "/api/auth/logout", null);
        await Assert.That(anonymous.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        var id = await fixture.CreateAccountAsync();
        using var login = await LoginAsync(fixture, await AuthTestRequests.UserNameAsync(fixture, id));
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var copiedCookies = new CookieContainer();
        var cookie = fixture.Cookies.GetCookies(fixture.Address)[HttpsApplicationFixture.CookieName]!;
        copiedCookies.Add(fixture.Address, new Cookie(cookie.Name, cookie.Value, "/") { Secure = true });
        var copiedClient = fixture.CreateClient(copiedCookies);
        using var logout = await AuthTestRequests.PostAsync(fixture, "/api/auth/logout", null);
        await Assert.That(logout.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(logout.Headers.GetValues("Set-Cookie").Any(header => header.StartsWith(HttpsApplicationFixture.CookieName + "=;", StringComparison.Ordinal))).IsTrue();
        using var gone = await fixture.Client.GetAsync("/api/auth/session");
        await Assert.That(gone.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        using var copied = await copiedClient.GetAsync("/api/auth/session");
        await Assert.That(copied.StatusCode).IsEqualTo(HttpStatusCode.OK);
    }

    private static async Task<(string? Hash, string? Stamp, bool Forced)> SnapshotAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var user = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync(user => user.Id == id);
        return (user.PasswordHash, user.SecurityStamp, user.MustChangePassword);
    }
    private static Task<HttpResponseMessage> LoginAsync(HttpsApplicationFixture fixture, string userName,
        string password = AuthTestRequests.CurrentPassword, string? token = null)
        => AuthTestRequests.PostAsync(fixture, "/api/auth/login", new { userName, password }, token: token);
}
