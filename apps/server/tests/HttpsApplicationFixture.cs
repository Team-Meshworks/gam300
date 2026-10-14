using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

internal sealed class HttpsApplicationFixture : IAsyncDisposable
{
    public const string CookieName = "__Host-Spatia.Application";
    public const string AbsoluteExpiryKey = "spatia.absoluteExpiresUtc";
    public const string SecretSentinel = "part3-secret-sentinel-do-not-log";
    private readonly X509Certificate2 _certificate;
    private readonly bool _ownsResources;
    private readonly string _artifactsRoot;
    private readonly Action<WebApplicationBuilder>? _configure;
    private readonly List<HttpClient> _clients = [];
    private int _writes;
    private int _heldRequests;

    private HttpsApplicationFixture(PostgresAccountFixture database, X509Certificate2 certificate,
        string keyDirectory, TestTimeProvider clock, bool ownsResources, Action<WebApplicationBuilder>? configure)
    {
        Database = database;
        _certificate = certificate;
        KeyDirectory = keyDirectory;
        Clock = clock;
        _ownsResources = ownsResources;
        _configure = configure;
        _artifactsRoot = Path.GetFullPath(Path.GetDirectoryName(keyDirectory)!);
    }

    public PostgresAccountFixture Database { get; }
    public string KeyDirectory { get; }
    public TestTimeProvider Clock { get; }
    public CapturedLogProvider Logs { get; } = new();
    public CookieContainer Cookies { get; } = new();
    public WebApplication App { get; private set; } = null!;
    public HttpClient Client { get; private set; } = null!;
    public Uri Address { get; private set; } = null!;
    public Uri HttpAddress { get; private set; } = null!;
    public int Writes => Volatile.Read(ref _writes);
    public IReadOnlyList<string> SignInCookieHeaders { get; private set; } = [];
    public TaskCompletionSource HoldsEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource ReleaseHolds { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public static async Task<HttpsApplicationFixture> CreateAsync(Action<WebApplicationBuilder>? configure = null)
    {
        var database = await PostgresAccountFixture.CreateAsync();
        var artifactsRoot = Path.GetFullPath(".artifacts");
        string? directory = null;
        X509Certificate2? certificate = null;
        HttpsApplicationFixture? fixture = null;
        try
        {
            directory = Path.Combine(artifactsRoot, "https-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=Spatia synthetic HTTPS test", rsa, HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder();
            names.AddIpAddress(IPAddress.Loopback);
            names.AddDnsName("localhost");
            request.CertificateExtensions.Add(names.Build());
            using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
            // Schannel needs the temporary PFX-backed key rather than the creation-time key
            certificate = X509CertificateLoader.LoadPkcs12(created.Export(X509ContentType.Pkcs12), password: null);
            fixture = new HttpsApplicationFixture(database, certificate, directory, new TestTimeProvider(), true, configure);
            await fixture.StartAsync();
            return fixture;
        }
        catch
        {
            if (fixture is not null)
            {
                await fixture.DisposeAsync();
            }
            else
            {
                certificate?.Dispose();
                if (directory is not null && Directory.Exists(directory))
                {
                    DeleteOwnedKeys(artifactsRoot, directory);
                }
                await database.DisposeAsync();
            }
            throw;
        }
    }
    public async Task<HttpsApplicationFixture> CreateSiblingAsync(Action<WebApplicationBuilder> configure)
    {
        var fixture = new HttpsApplicationFixture(Database, _certificate, KeyDirectory, Clock, false, configure);
        try
        {
            await fixture.StartAsync();
            return fixture;
        }
        catch
        {
            await fixture.DisposeAsync();
            throw;
        }
    }

    public HttpClient CreateClient(CookieContainer? cookies = null)
    {
        var handler = new HttpClientHandler
        {
            CookieContainer = cookies ?? new CookieContainer(),
            AllowAutoRedirect = false,
            ServerCertificateCustomValidationCallback = (_, certificate, _, _) =>
                certificate is not null && certificate.RawData.AsSpan().SequenceEqual(_certificate.RawData),
        };
        var client = new HttpClient(handler) { BaseAddress = Address, Timeout = TimeSpan.FromSeconds(15) };
        _clients.Add(client);
        return client;
    }

    public async Task<Guid> CreateAccountAsync(string role = ApplicationRoles.Creator, bool forced = false)
    {
        await using var scope = Database.Services.CreateAsyncScope();
        var user = new ApplicationUser
        {
            Id = Guid.NewGuid(),
            UserName = "test-" + Guid.NewGuid().ToString("N"),
            MustChangePassword = forced
        };
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        if (!(await manager.CreateAsync(user, "Synthetic-long-password1!")).Succeeded
            || !(await manager.AddToRoleAsync(user, role)).Succeeded)
        {
            throw new InvalidOperationException("Synthetic Identity account creation failed.");
        }

        if (role != ApplicationRoles.Administrator)
        {
            var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = new Organization { Id = Guid.NewGuid(), Name = "Synthetic organization" };
            context.Organizations.Add(organization);
            context.OrganizationMemberships.Add(new OrganizationMembership
            {
                UserId = user.Id,
                OrganizationId = organization.Id,
                RoleId = role == ApplicationRoles.Creator ? ApplicationRoles.CreatorId : ApplicationRoles.EducatorId,
            });
            await context.SaveChangesAsync();
        }

        return user.Id;
    }

    public async Task SignInAsync(Guid id, HttpClient? client = null, string? forgedRole = null)
    {
        client ??= Client;
        var token = await GetCsrfAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/_test/signin/" + id.ToString("D")
            + (forgedRole is null ? "" : "?role=" + Uri.EscapeDataString(forgedRole)));
        request.Headers.Add("X-CSRF-TOKEN", token);
        using var response = await client.SendAsync(request);
        SignInCookieHeaders = response.Headers.TryGetValues("Set-Cookie", out var headers) ? headers.ToArray() : [];
        if (response.StatusCode != HttpStatusCode.NoContent)
        {
            throw new InvalidOperationException("Test-only cookie minting failed.");
        }
    }

    public async Task<string> GetCsrfAsync(HttpClient? client = null)
    {
        using var response = await (client ?? Client).GetAsync("/api/auth/csrf");
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("requestToken").GetString()
            ?? throw new InvalidOperationException("Expected an antiforgery token.");
    }

    public AuthenticationTicket ReadTicket()
    {
        var cookie = Cookies.GetCookies(Address)[CookieName]?.Value
            ?? throw new InvalidOperationException("Expected a synthetic session cookie.");
        var options = App.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
            .Get(IdentityConstants.ApplicationScheme);
        return options.TicketDataFormat.Unprotect(cookie)
            ?? throw new InvalidOperationException("Expected a readable synthetic ticket.");
    }

    public void ReplaceTicket(AuthenticationTicket ticket)
    {
        var options = App.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
            .Get(IdentityConstants.ApplicationScheme);
        Cookies.Add(Address, new Cookie(CookieName, options.TicketDataFormat.Protect(ticket), "/") { Secure = true });
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        await StartAsync();
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await StopAsync();
        }
        finally
        {
            if (_ownsResources)
            {
                try
                {
                    await Database.DisposeAsync();
                }
                finally
                {
                    _certificate.Dispose();
                    DeleteOwnedKeys(_artifactsRoot, KeyDirectory);
                }
            }
        }
    }

    private static void DeleteOwnedKeys(string artifactsRoot, string directory)
    {
        var resolvedRoot = Path.GetFullPath(artifactsRoot);
        var resolvedDirectory = Path.GetFullPath(directory);
        var name = Path.GetFileName(resolvedDirectory);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!string.Equals(Path.GetDirectoryName(resolvedDirectory), resolvedRoot, comparison)
            || !name.StartsWith("https-", StringComparison.Ordinal) || !Guid.TryParseExact(name[6..], "N", out _))
        {
            throw new InvalidOperationException("Refusing to remove an unowned test key directory.");
        }
        Directory.Delete(resolvedDirectory, true);
    }
    private async Task StartAsync()
    {
        await using var databaseScope = Database.Services.CreateAsyncScope();
        var connectionString = databaseScope.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .Database.GetConnectionString() ?? throw new InvalidOperationException("Missing test database configuration.");
        var scopedConnection = new NpgsqlConnectionStringBuilder(connectionString)
        {
            ApplicationName = "Spatia.Part3." + Database.SchemaName,
        };
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Spatia"] = scopedConnection.ConnectionString,
            ["DataProtection:KeyDirectory"] = KeyDirectory,
            ["AllowedHosts"] = "127.0.0.1;localhost",
        });
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(Logs);
        builder.Services.AddSingleton<TimeProvider>(Clock);
        builder.Services.PostConfigure<CookieAuthenticationOptions>(IdentityConstants.ApplicationScheme,
            options => options.TimeProvider = Clock);
        builder.Services.PostConfigure<SecurityStampValidatorOptions>(options => options.TimeProvider = Clock);
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Listen(IPAddress.Loopback, 0, listener => listener.UseHttps(_certificate));
            options.Listen(IPAddress.Loopback, 0);
        });
        _configure?.Invoke(builder);
        App = SpatiaApplication.Build(builder);
        MapProbes(App);
        await App.StartAsync();
        var addresses = App.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
        Address = new Uri(addresses.Single(address => address.StartsWith("https://", StringComparison.Ordinal)));
        HttpAddress = new Uri(addresses.Single(address => address.StartsWith("http://", StringComparison.Ordinal)));
        Client = CreateClient(Cookies);
    }

    private async Task StopAsync()
    {
        ReleaseHolds.TrySetResult();
        foreach (var client in _clients)
        {
            client.Dispose();
        }
        _clients.Clear();
        if (App is not null)
        {
            await App.StopAsync();
            await App.DisposeAsync();
            App = null!;
        }
    }

    private void MapProbes(WebApplication app)
    {
        app.MapPost("/_test/signin/{id:guid}", async (Guid id, HttpContext context, SignInManager<ApplicationUser> manager) =>
        {
            var user = await manager.UserManager.FindByIdAsync(id.ToString("D"))
                ?? throw new InvalidOperationException("Missing synthetic account.");
            var principal = await manager.CreateUserPrincipalAsync(user);
            if (context.Request.Query["role"].FirstOrDefault() is { } forgedRole)
            {
                var identity = (ClaimsIdentity)principal.Identity!;
                identity.AddClaim(new Claim(identity.RoleClaimType, forgedRole));
                principal.AddIdentity(new ClaimsIdentity([new Claim(ClaimTypes.Role, forgedRole)], "forged-test-identity"));
                identity.AddClaim(new Claim("orgId", Guid.NewGuid().ToString("D")));
            }
            await context.SignInAsync(IdentityConstants.ApplicationScheme, principal,
                new AuthenticationProperties { IsPersistent = true });
            return Results.NoContent();
        }).AllowAnonymous();
        app.MapGet("/_test/probe", (HttpContext context) => Results.Json(context.Features.Get<CurrentAccount>()));
        app.MapGet("/_test/admin", () => Results.NoContent()).RequireAuthorization(SecurityPolicies.Administrator);
        app.MapGet("/api/auth/session", (HttpContext context) => Results.Json(context.Features.Get<CurrentAccount>()))
            .RequireAuthorization(SecurityPolicies.CurrentAccount);
        app.MapGet("/_test/current", () => Results.NoContent()).RequireAuthorization(SecurityPolicies.CurrentAccount);
        app.MapPost("/api/auth/logout", () => Results.NoContent()).RequireAuthorization(SecurityPolicies.CurrentAccount);
        app.MapPut("/api/auth/logout", () => Results.NoContent()).RequireAuthorization(SecurityPolicies.CurrentAccount);
        app.MapPost("/_test/write", async (HttpContext context) =>
        {
            await context.Request.Body.CopyToAsync(Stream.Null, context.RequestAborted);
            Interlocked.Increment(ref _writes);
            return Results.NoContent();
        });
        app.MapPost("/_test/anonymous-write", () => Results.NoContent()).AllowAnonymous();
        app.MapPost("/_test/rate-write", () => Results.NoContent()).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        app.MapGet("/_test/rate-auth", () => Results.NoContent()).AllowAnonymous()
            .RequireRateLimiting(SecurityPolicies.AuthenticationRateLimit);
        app.MapGet("/_test/transport", (HttpContext context) => Results.Json(new
        {
            scheme = context.Request.Scheme,
            host = context.Request.Host.Value,
            remoteIp = context.Connection.RemoteIpAddress?.ToString(),
        })).AllowAnonymous();
        app.MapGet("/_test/error", () => { throw new InvalidOperationException(SecretSentinel); }).AllowAnonymous();
        app.MapGet("/_test/started-error", async (HttpContext context) =>
        {
            await context.Response.WriteAsync("safe-prefix");
            await context.Response.Body.FlushAsync();
            throw new InvalidOperationException(SecretSentinel);
        }).AllowAnonymous();
        app.MapGet("/_test/browser", () => Results.Content("<!doctype html><title>Spatia CSRF boundary test</title>", "text/html"))
            .AllowAnonymous();
        app.MapGet("/_test/hold", async (HttpContext context) =>
        {
            if (Interlocked.Increment(ref _heldRequests) == 64)
            {
                HoldsEntered.TrySetResult();
            }
            await ReleaseHolds.Task.WaitAsync(context.RequestAborted);
            return Results.NoContent();
        }).AllowAnonymous();
    }
}
