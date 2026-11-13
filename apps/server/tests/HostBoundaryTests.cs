using Microsoft.AspNetCore.RateLimiting;
using Spatia.Server.Security;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(HostBoundaryTests))]
public sealed class HostBoundaryTests
{
    [Test]
    [Arguments("ConnectionStrings:Spatia", null)]
    [Arguments("DataProtection:KeyDirectory", null)]
    [Arguments("AllowedHosts", null)]
    [Arguments("ConnectionStrings:Spatia", "Host=127.0.0.1;Database=synthetic;UnknownSetting=part3-secret-sentinel-do-not-log")]
    [Arguments("ConnectionStrings:Spatia", "Host=127.0.0.1;Username=synthetic")]
    [Arguments("ConnectionStrings:Spatia", "Database=synthetic;Username=synthetic")]
    [Arguments("ConnectionStrings:Spatia", "Host=127.0.0.1;Database=synthetic")]
    [Arguments("DataProtection:KeyDirectory", "relative-key-directory")]
    [Arguments("DataProtection:KeyDirectory", "missing-absolute-directory")]
    [Arguments("ForwardedHeaders_Enabled", "true")]
    [Arguments("ForwardedHeaders_Enabled", "invalid")]
    [Arguments("TrustedProxies:0", "example.invalid")]
    [Arguments("TrustedProxies:0", "127.0.0.1/8")]
    public async Task Startup_MissingOrInvalidConfiguration_ReturnsFixedNonsecretError(string key, string? value)
    {
        var builder = CreateConfigurationBuilder();
        builder.Configuration[key] = value == "missing-absolute-directory"
            ? Path.Combine(AppContext.BaseDirectory, "missing-" + Guid.NewGuid().ToString("N"))
            : value;
        var exception = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var app = SpatiaApplication.Build(builder);
        }) ?? throw new InvalidOperationException("Expected a startup configuration failure.");
        await Assert.That(exception.Message.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        await Assert.That(exception.InnerException is null).IsTrue();
    }

    [Test]
    [Arguments("*")]
    [Arguments("*.example.test")]
    [Arguments("0.0.0.0")]
    [Arguments("0")]
    [Arguments("[::]")]
    [Arguments("::")]
    [Arguments("0:0:0:0:0:0:0:0")]
    [Arguments("host:443")]
    [Arguments("http://example.test")]
    [Arguments("bad host")]
    public async Task Startup_WildcardOrMalformedAllowedHost_IsRejected(string host)
    {
        var builder = CreateConfigurationBuilder();
        builder.Configuration["AllowedHosts"] = host;
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var app = SpatiaApplication.Build(builder);
        });
    }

    [Test]
    [Arguments("localhost")]
    [Arguments("example.test")]
    [Arguments("127.0.0.1")]
    [Arguments("[::1]")]
    [Arguments("::1")]
    public async Task Startup_ExplicitDnsOrIpHost_IsAcceptedWithoutConnecting(string host)
    {
        var builder = CreateConfigurationBuilder();
        builder.Configuration["AllowedHosts"] = host;
        await using var app = SpatiaApplication.Build(builder);
        await Assert.That(app is not null).IsTrue();
    }

    [Test]
    public async Task ProductionRouteInventory_ContainsOnlyReviewedAccountProjectClassAndAssetRoutes()
    {
        await using var app = SpatiaApplication.Build(CreateConfigurationBuilder());
        var endpoints = ((IEndpointRouteBuilder)app).DataSources.SelectMany(source => source.Endpoints).OfType<RouteEndpoint>().ToArray();
        var expected = new[] { "GET /api/v1/auth/csrf", "POST /api/v1/auth/login", "GET /api/v1/auth/session", "GET /api/v1/auth/asset-access", "POST /api/v1/auth/logout", "POST /api/v1/auth/password",
            "POST /api/v1/admin/organizations", "POST /api/v1/admin/users", "POST /api/v1/admin/users/bulk", "POST /api/v1/admin/organizations/{id:guid}/students/delete", "POST /api/v1/admin/organizations/{id:guid}/students/hide", "POST /api/v1/admin/users/{id:guid}/password",
            "GET /api/v1/admin/users", "GET /api/v1/admin/users/{id:guid}", "GET /api/v1/admin/organizations", "GET /api/v1/admin/organizations/{id:guid}",
            "PATCH /api/v1/admin/users/{id:guid}/active", "DELETE /api/v1/admin/users/{id:guid}",
            "PATCH /api/v1/admin/users/{id:guid}", "GET /api/v1/admin/organizations/{id:guid}/projects",
            "PATCH /api/v1/admin/organizations/{id:guid}/active",
            "GET /api/v1/admin/organizations/{id:guid}/deletion", "DELETE /api/v1/admin/organizations/{id:guid}",
            "GET /api/v1/projects/", "GET /api/v1/projects/{id:guid}", "GET /api/v1/projects/{id:guid}/assignments", "PUT /api/v1/projects/{id:guid}",
            "POST /api/v1/projects/", "POST /api/v1/projects/{id:guid}/duplicate", "POST /api/v1/projects/{id:guid}/submissions", "PATCH /api/v1/projects/{id:guid}/assignments", "PATCH /api/v1/projects/{id:guid}/archive",
            "GET /api/v1/projects/{id:guid}/submissions", "GET /api/v1/projects/{id:guid}/submissions/{submissionId:guid}",
            "GET /api/v1/projects/{id:guid}/image",
            "GET /api/v1/projects/{projectId:guid}/exhibition", "GET /api/v1/projects/{projectId:guid}/exhibitions/{publicationId:guid}/assets/{assetId}/bytes",
            "GET /api/v1/projects/{id:guid}/progress-reviews", "POST /api/v1/projects/{id:guid}/progress-reviews",
            "POST /api/v1/projects/{id:guid}/submissions/{submissionId:guid}/decisions",
            "GET /api/v1/classes/", "GET /api/v1/classes/{id:guid}", "GET /api/v1/classes/{id:guid}/roster", "GET /api/v1/classes/{id:guid}/eligible-students",
            "GET /api/v1/classes/{id:guid}/assignments", "GET /api/v1/classes/{id:guid}/assignments/{assignmentId:guid}", "PATCH /api/v1/classes/{id:guid}/assignments/{assignmentId:guid}",
            "POST /api/v1/classes/", "POST /api/v1/classes/{id:guid}/assignments", "PUT /api/v1/classes/{id:guid}/members/{userId:guid}", "DELETE /api/v1/classes/{id:guid}/members/{userId:guid}",
            "GET /api/v1/admin/assets/", "GET /api/v1/admin/assets/{id:guid}/bytes", "POST /api/v1/admin/assets/", "POST /api/v1/admin/assets/{id:guid}/approve",
            "POST /api/v1/admin/assets/{id:guid}/availability", "GET /api/v1/assets", "GET /api/v1/assets/{id:guid}/bytes",
            "GET /api/v1/projects/{projectId:guid}/assets/{id:guid}/bytes", "GET /api/v1/projects/{projectId:guid}/assets", "GET /api/v1/projects/{projectId:guid}/publication-links", "GET /api/v1/projects/publication-links",
            "GET,HEAD /api/v1/publications/{publicationId}", "GET /api/v1/publications/{publicationId}/manifest", "GET,HEAD /api/v1/publications/{publicationId}/assets/{assetId}/bytes",
            "GET /api/v1/publications/{publicationId:guid}/access", "POST /api/v1/publications/{publicationId:guid}/access",
            "GET /api/v1/admin/projects/publication-moderation", "POST /api/v1/admin/projects/publication-moderation", "POST /api/v1/projects/publication-moderation", "POST /api/v1/admin/projects/{projectId:guid}/publication-moderation",
            "GET /api/v1/projects/publication-moderation", "POST /api/v1/projects/{projectId:guid}/publication-moderation",
            "POST /api/v1/projects/{id:guid}/publications", "GET /api/v1/projects/{id:guid}/publication-readiness", "GET /api/v1/projects/{id:guid}/publication-viewers" };
        await Assert.That(string.Join(";", endpoints.Select(endpoint =>
            string.Join(",", endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods) + " " + endpoint.RoutePattern.RawText).Order()))
            .IsEqualTo(string.Join(";", expected.Order()));
        foreach (var endpoint in endpoints)
        {
            var path = endpoint.RoutePattern.RawText!;
            var csrf = path == "/api/v1/auth/csrf";
            var login = path == "/api/v1/auth/login";
            var session = path == "/api/v1/auth/session";
            var project = path.StartsWith("/api/v1/projects", StringComparison.Ordinal)
                || path.StartsWith("/api/v1/assets", StringComparison.Ordinal);
            var publication = path.StartsWith("/api/v1/publications", StringComparison.Ordinal);
            var publicationRead = publication && !path.EndsWith("/access", StringComparison.Ordinal) && endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.All(method => method is "GET" or "HEAD");
            var assetBytes = path.EndsWith("/bytes", StringComparison.Ordinal);
            var upload = path == "/api/v1/admin/assets/" && endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.Single() == "POST";
            var classroom = path.StartsWith("/api/v1/classes", StringComparison.Ordinal);
            await Assert.That(endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null).IsEqualTo(csrf || login || publicationRead);
            if (!csrf && !login && !publicationRead)
            {
                await Assert.That(endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Any(data =>
                    data.Policy == (path.StartsWith("/api/v1/admin/", StringComparison.Ordinal)
                        ? SecurityPolicies.Administrator : project || classroom || publication ? SecurityPolicies.FullAccount : SecurityPolicies.CurrentAccount))).IsTrue();
            }
            var method = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.First();
            if (assetBytes || (!csrf && !session && method != "GET"
                && (!(project || classroom) || method is "POST" or "PATCH" || (classroom && method is "PUT" or "DELETE"))))
            {
                await Assert.That(endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName)
                    .IsEqualTo(login ? SecurityPolicies.AuthenticationRateLimit : assetBytes ? "AssetBytes" : upload ? "AssetIntake" : SecurityPolicies.AccountWriteRateLimit);
            }
        }
    }
    [Test]
    public async Task PublicRegistrationPaths_DoNotRegisterOrRedirect()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        foreach (var path in new[] { "/register", "/api/v1/register", "/api/v1/auth/register" })
        {
            using var response = await fixture.Client.PostAsJsonAsync(path, new
            {
                userName = "synthetic",
                password = HttpsApplicationFixture.SecretSentinel,
            });
            await Assert.That(response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.NotFound).IsTrue();
            await Assert.That(response.Headers.Location is null).IsTrue();
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Transport_UntrustedForwardedHeadersCannotReplaceHttpsOrClientIp()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/_test/transport");
        request.Headers.Add("X-Forwarded-For", "203.0.113.10");
        request.Headers.Add("X-Forwarded-Proto", "http");
        request.Headers.Add("X-Forwarded-Host", "attacker.example");
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var transport = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(transport.GetProperty("scheme").GetString()).IsEqualTo("https");
        await Assert.That(transport.GetProperty("remoteIp").GetString()).IsEqualTo("127.0.0.1");
        await Assert.That(transport.GetProperty("host").GetString()!.StartsWith("127.0.0.1:", StringComparison.Ordinal)).IsTrue();

        using var insecure = new HttpRequestMessage(HttpMethod.Get, new Uri(fixture.HttpAddress, "/_test/transport"));
        insecure.Headers.Add("X-Forwarded-Proto", "https");
        using var rejected = await fixture.Client.SendAsync(insecure);
        await AssertProblemAsync(rejected, HttpStatusCode.BadRequest, "https_required");
        await Assert.That(rejected.Headers.Location is null).IsTrue();
    }

    [Test]
    public async Task Transport_ExplicitProxyUsesSingleRightmostHopAndIgnoresForwardedHost()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Configuration["TrustedProxies:0"] = "127.0.0.1");
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(fixture.HttpAddress, "/_test/transport"));
        request.Headers.Add("X-Forwarded-For", "198.51.100.20, 203.0.113.10");
        request.Headers.Add("X-Forwarded-Proto", "http, https");
        request.Headers.Add("X-Forwarded-Host", "attacker.example");
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var transport = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(transport.GetProperty("scheme").GetString()).IsEqualTo("https");
        await Assert.That(transport.GetProperty("remoteIp").GetString()).IsEqualTo("203.0.113.10");
        await Assert.That(transport.GetProperty("host").GetString()!.StartsWith("127.0.0.1:", StringComparison.Ordinal)).IsTrue();
    }

    [Test]
    public async Task Transport_UnexpectedHost_ReturnsFixedEmptyBadRequest()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/auth/csrf");
        request.Headers.Host = "attacker.example";
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await Assert.That(await response.Content.ReadAsStringAsync()).IsEqualTo("");
        await Assert.That(response.Headers.Location is null).IsTrue();
    }

    // Kestrel counts the single four-digit chunk's 13 framing bytes against its body limit
    [Test]
    [Arguments(16384, false, HttpStatusCode.NoContent)]
    [Arguments(16371, true, HttpStatusCode.NoContent)]
    [Arguments(16385, false, HttpStatusCode.RequestEntityTooLarge)]
    [Arguments(16372, true, HttpStatusCode.RequestEntityTooLarge)]
    public async Task RequestBody_ContentLengthAndSingleChunk_EnforceKestrelSixteenKiBCeiling(int bytes, bool chunked, HttpStatusCode status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var request = new HttpRequestMessage(HttpMethod.Post, "/_test/write")
        {
            Version = HttpVersion.Version11,
            VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            Content = new ByteArrayContent(Encoding.UTF8.GetBytes("\"" + new string('x', bytes - 2) + "\"")),
        };
        request.Content.Headers.ContentType = new("application/json");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        if (chunked)
        {
            request.Headers.TransferEncodingChunked = true;
        }
        else if (status == HttpStatusCode.RequestEntityTooLarge)
        {
            // Receive the size rejection before uploading a declared oversized body
            request.Headers.ExpectContinue = true;
        }
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(status);
        await Assert.That(fixture.Writes).IsEqualTo(status == HttpStatusCode.NoContent ? 1 : 0);
        if (status == HttpStatusCode.RequestEntityTooLarge)
        {
            await AssertProblemAsync(response, status, "request_too_large");
        }
    }

    [Test]
    public async Task RequestBody_OrdinaryOversizedUploadNeverReachesWrite()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var request = new HttpRequestMessage(HttpMethod.Post, "/_test/write")
        {
            Version = HttpVersion.Version11,
            VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            Content = new ByteArrayContent(new byte[17 * 1024]),
        };
        request.Content.Headers.ContentType = new("application/json");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        try
        {
            using var response = await fixture.Client.SendAsync(request);
            await AssertProblemAsync(response, HttpStatusCode.RequestEntityTooLarge, "request_too_large");
        }
        catch (HttpRequestException error) when (
            error.HttpRequestError == HttpRequestError.ResponseEnded
            || error.InnerException is IOException
            {
                InnerException: SocketException
                {
                    SocketErrorCode: SocketError.ConnectionReset or SocketError.ConnectionAborted
                }
            })
        {
            // Kestrel may close a connection while an oversized body is already being sent
        }

        // A transport reset is acceptable only after the server actually rejects the request
        const string rejection = "request_completed POST /_test/write 413 ";
        for (var attempt = 0; attempt < 100 && !fixture.Logs.Messages.Contains(rejection, StringComparison.Ordinal); attempt++)
        {
            await Task.Delay(10);
        }
        await Assert.That(fixture.Logs.Messages.Contains(rejection, StringComparison.Ordinal)).IsTrue();
        await Assert.That(fixture.Writes).IsEqualTo(0);
    }

    [Test]
    public async Task RateLimit_AuthenticationPerIp_ReturnsRetryAfterAtSixtyRequests()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        for (var index = 0; index < 60; index++)
        {
            using var accepted = await fixture.Client.GetAsync("/_test/rate-auth");
            await Assert.That(accepted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        using var rejected = await fixture.Client.GetAsync("/_test/rate-auth");
        await AssertRateLimitedAsync(rejected);
    }

    [Test]
    public async Task RateLimit_WritesPartitionByValidatedUserInsteadOfSharedIp()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var token = await fixture.GetCsrfAsync();
        for (var index = 0; index < 20; index++)
        {
            using var request = RequestSecurityTests.CreateWrite("/_test/rate-write", token);
            using var accepted = await fixture.Client.SendAsync(request);
            await Assert.That(accepted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        using (var request = RequestSecurityTests.CreateWrite("/_test/rate-write", token))
        using (var rejected = await fixture.Client.SendAsync(request))
        {
            await AssertRateLimitedAsync(rejected);
        }
        var other = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(), other);
        using var otherRequest = RequestSecurityTests.CreateWrite("/_test/rate-write", await fixture.GetCsrfAsync(other));
        using var otherResponse = await other.SendAsync(otherRequest);
        await Assert.That(otherResponse.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
    }

    [Test]
    public async Task RateLimit_GlobalConcurrencyRejectsRequestSixtyFiveWithoutQueueing()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var held = Enumerable.Range(0, 64).Select(_ => fixture.Client.GetAsync("/_test/hold")).ToArray();
        try
        {
            await fixture.HoldsEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var rejected = await fixture.Client.GetAsync("/_test/hold");
            await AssertRateLimitedAsync(rejected);
        }
        finally
        {
            fixture.ReleaseHolds.TrySetResult();
            var responses = await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(10));
            foreach (var response in responses)
            {
                using (response)
                {
                    await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
                }
            }
        }
    }

    [Test]
    public async Task SafeErrors_DevelopmentAndOverridingLogRules_NeverExposeSecrets()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Environment.EnvironmentName = "Development";
            builder.Services.Configure<LoggerFilterOptions>(options =>
            {
                options.Rules.Add(new LoggerFilterRule(null, "microsoft.aspnetcore.hosting.diagnostics", LogLevel.Trace, null));
                options.Rules.Add(new LoggerFilterRule(null, "Microsoft.*Hosting.Diagnostics", LogLevel.Trace, null));
                options.Rules.Add(new LoggerFilterRule(typeof(CapturedLogProvider).FullName, "npgsql.*", LogLevel.Trace, null));
                options.Rules.Add(new LoggerFilterRule(typeof(CapturedLogProvider).FullName, "Microsoft.*Diagnostics", LogLevel.Trace, null));
                options.Rules.Add(new LoggerFilterRule(null, "Unrelated.Blocked", LogLevel.Trace, (_, _, _) => false));
            });
        });
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var token = await fixture.GetCsrfAsync();
        var cookie = fixture.Cookies.GetCookies(fixture.Address)[fixture.CookieName]?.Value
            ?? throw new InvalidOperationException("Expected the synthetic session cookie.");
        using var request = new HttpRequestMessage(HttpMethod.Get, "/_test/error?secret=" + HttpsApplicationFixture.SecretSentinel);
        request.Headers.Add("X-Synthetic-Secret", HttpsApplicationFixture.SecretSentinel);
        using var response = await fixture.Client.SendAsync(request);
        await AssertProblemAsync(response, HttpStatusCode.InternalServerError, "internal_error");
        var logs = fixture.App.Services.GetRequiredService<ILoggerFactory>();
        foreach (var category in new[]
        {
            "Microsoft.AspNetCore.Hosting.Diagnostics", "microsoft.aspnetcore.hosting.diagnostics",
            "Microsoft.EntityFrameworkCore.Database.Command", "Npgsql.Connection",
        })
        {
            logs.CreateLogger(category).LogError(new InvalidOperationException(HttpsApplicationFixture.SecretSentinel),
                "synthetic_private_event {Secret}", HttpsApplicationFixture.SecretSentinel);
        }
        logs.CreateLogger("Unrelated.Blocked").LogInformation(HttpsApplicationFixture.SecretSentinel);
        logs.CreateLogger("Unrelated.Allowed").LogInformation("synthetic_unrelated_event");
        await Assert.That(fixture.Logs.Messages.Contains("synthetic_unrelated_event", StringComparison.Ordinal)).IsTrue();
        await Assert.That(fixture.Logs.Messages.Contains("request_failure internal_error", StringComparison.Ordinal)).IsTrue();
        await Assert.That(fixture.Logs.Messages.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(cookie, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(token, StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    public async Task SafeErrors_ResponseAlreadyStarted_AbortsWithoutDeveloperDetailsOrRawLogs()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Environment.EnvironmentName = "Development");
        var aborted = false;
        try
        {
            using var response = await fixture.Client.GetAsync("/_test/started-error", HttpCompletionOption.ResponseHeadersRead);
            var body = await response.Content.ReadAsStringAsync();
            await Assert.That(body.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        }
        catch (HttpRequestException)
        {
            aborted = true;
        }
        catch (IOException)
        {
            aborted = true;
        }
        await Assert.That(aborted).IsTrue();
        await Assert.That(fixture.Logs.Messages.Contains("response_aborted", StringComparison.Ordinal)).IsTrue();
        await Assert.That(fixture.Logs.Messages.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    public async Task Storage_RealUnavailableSiblingConnection_Returns503AndPreservesCookie()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var originalCookie = fixture.Cookies.GetCookies(fixture.Address)[fixture.CookieName]?.Value
            ?? throw new InvalidOperationException("Expected the synthetic session cookie.");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var connection = new NpgsqlConnectionStringBuilder(scope.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .Database.GetConnectionString());
        using var reservedPort = new TcpListener(IPAddress.Loopback, 0);
        reservedPort.Start();
        connection.Host = "127.0.0.1";
        connection.Port = ((IPEndPoint)reservedPort.LocalEndpoint).Port;
        connection.Timeout = 1;
        connection.CommandTimeout = 1;
        connection.Pooling = false;
        connection.ApplicationName = HttpsApplicationFixture.SecretSentinel;
        await using var unavailable = await fixture.CreateSiblingAsync(builder =>
            builder.Configuration["ConnectionStrings:Spatia"] = connection.ConnectionString);
        var outageClient = unavailable.CreateClient(fixture.Cookies);
        using var failure = await outageClient.GetAsync("/_test/probe");
        await AssertProblemAsync(failure, HttpStatusCode.ServiceUnavailable, "storage_unavailable");
        await Assert.That(fixture.Cookies.GetCookies(fixture.Address)[fixture.CookieName]?.Value == originalCookie).IsTrue();
        await Assert.That(!failure.Headers.TryGetValues("Set-Cookie", out var headers)
            || !headers.Any(header => header.StartsWith(fixture.CookieName + "=", StringComparison.Ordinal))).IsTrue();
        await Assert.That(unavailable.Logs.Messages.Contains("request_failure storage_unavailable", StringComparison.Ordinal)).IsTrue();
        await Assert.That(unavailable.Logs.Messages.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        using var live = await fixture.Client.GetAsync("/_test/probe");
        await Assert.That(live.StatusCode).IsEqualTo(HttpStatusCode.OK);
    }

    private static WebApplicationBuilder CreateConfigurationBuilder()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Spatia"] = "Host=127.0.0.1;Database=synthetic_configuration_only;Username=synthetic",
            ["DataProtection:KeyDirectory"] = AppContext.BaseDirectory,
            ["AllowedHosts"] = "localhost",
        });
        builder.Logging.ClearProviders();
        return builder;
    }

    private static async Task AssertProblemAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        await Assert.That(response.StatusCode).IsEqualTo(status);
        await Assert.That(response.Content.Headers.ContentType?.MediaType).IsEqualTo("application/problem+json");
        var body = await response.Content.ReadAsStringAsync();
        await Assert.That(body.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        using var json = JsonDocument.Parse(body);
        await Assert.That(json.RootElement.GetProperty("code").GetString()).IsEqualTo(code);
        await Assert.That(json.RootElement.GetProperty("status").GetInt32()).IsEqualTo((int)status);
        await Assert.That(!string.IsNullOrWhiteSpace(json.RootElement.GetProperty("traceId").GetString())).IsTrue();
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
    }

    private static async Task AssertRateLimitedAsync(HttpResponseMessage response)
    {
        await AssertProblemAsync(response, HttpStatusCode.TooManyRequests, "rate_limited");
        await Assert.That(response.Headers.RetryAfter?.Delta is { } delay && delay > TimeSpan.Zero).IsTrue();
    }
}
