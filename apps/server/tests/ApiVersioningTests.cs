using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

public sealed class ApiVersioningTests
{
    [Test]
    public async Task Routes_OnlyV1RetainsReviewedBodyLimits()
    {
        await using var app = Build();
        var endpoints = ((IEndpointRouteBuilder)app).DataSources.SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>().ToArray();
        await Assert.That(endpoints.Length).IsGreaterThan(0);
        foreach (var endpoint in endpoints)
        {
            await Assert.That(endpoint.RoutePattern.RawText!.StartsWith("/api/v1/", StringComparison.Ordinal)).IsTrue();
            var method = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.Single();
            long? expected = (method, endpoint.RoutePattern.RawText) switch
            {
                ("POST", "/api/v1/projects/") or ("PUT", "/api/v1/projects/{id:guid}") => 6 * 1024 * 1024,
                ("POST", "/api/v1/admin/assets/") => 20 * 1024 * 1024,
                ("POST", "/api/v1/admin/assets/{id:guid}/approve") => 40 * 1024,
                ("POST", "/api/v1/projects/{id:guid}/publications") or ("POST", "/api/v1/publications/{publicationId:guid}/access") => 16 * 1024,
                _ => null,
            };
            await Assert.That(endpoint.Metadata.GetMetadata<IRequestSizeLimitMetadata>()?.MaxRequestBodySize)
                .IsEqualTo(expected);
        }
    }

    [Test]
    [Arguments("/api/v1")]
    [Arguments("/API/V1")]
    public async Task ForcedPasswordSession_RetainsOnlyItsRecoveryRoutes(string prefix)
    {
        await using var app = Build();
        await using var scope = app.Services.CreateAsyncScope();
        var authorization = scope.ServiceProvider.GetRequiredService<IAuthorizationService>();
        var policies = scope.ServiceProvider.GetRequiredService<IAuthorizationPolicyProvider>();
        var endpoints = ((IEndpointRouteBuilder)app).DataSources.SelectMany(source => source.Endpoints).OfType<RouteEndpoint>();
        var actor = new CurrentAccount(Guid.NewGuid(), "synthetic", ApplicationRoles.Creator, Guid.NewGuid(), true);
        var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, actor.UserId.ToString())], "synthetic"));
        foreach (var (method, path, allowed) in new[]
        {
            ("GET", "/auth/session", true), ("POST", "/auth/password", true), ("POST", "/auth/logout", true),
            ("GET", "/auth/asset-access", false), ("GET", "/projects/", false),
        })
        {
            var endpoint = endpoints.Single(endpoint => endpoint.RoutePattern.RawText == "/api/v1" + path
                && endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.Single() == method);
            var policy = await AuthorizationPolicy.CombineAsync(policies, endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>())
                ?? throw new InvalidOperationException("Expected an explicit authorization policy.");
            foreach (var suffix in new[] { "", "/" })
            {
                var context = new DefaultHttpContext { User = principal };
                context.Request.Method = method;
                context.Request.Path = prefix + path.TrimEnd('/') + suffix;
                context.Features.Set(actor);
                context.SetEndpoint(endpoint);
                await Assert.That((await authorization.AuthorizeAsync(principal, context, policy)).Succeeded).IsEqualTo(allowed);
            }
        }
    }

    [Test]
    public async Task Http_V1PreservesSecurityAndRejectsUnknownVersions()
    {
        await using var app = Build();
        await app.StartAsync();
        using var client = CreateClient(app);
        foreach (var prefix in new[] { "/api/v1", "/API/V1" })
        {
            using var csrf = await client.GetAsync(prefix + "/auth/csrf");
            await Assert.That(csrf.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(csrf.Headers.CacheControl?.NoStore == true).IsTrue();
            var value = await csrf.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(string.IsNullOrEmpty(value.GetProperty("requestToken").GetString())).IsFalse();
            await Assert.That(csrf.Headers.GetValues("Set-Cookie").Any(cookie => cookie.Contains("secure", StringComparison.OrdinalIgnoreCase)
                && cookie.Contains("path=/", StringComparison.OrdinalIgnoreCase))).IsTrue();
            using var session = await client.GetAsync(prefix + "/auth/session");
            await AssertProblemAsync(session, HttpStatusCode.Unauthorized, "authentication_required");
            using var login = await client.PostAsJsonAsync(prefix + "/auth/login", new { });
            await AssertProblemAsync(login, HttpStatusCode.BadRequest, "csrf_invalid");
            using var body = new StringContent(JsonSerializer.Serialize(new { password = new string('x', 17_000) }),
                System.Text.Encoding.UTF8, "application/json");
            using var oversized = await client.PostAsync(prefix + "/auth/login", body);
            await AssertProblemAsync(oversized, HttpStatusCode.RequestEntityTooLarge, "request_too_large");
            foreach (var (method, path) in new[]
            {
                (HttpMethod.Post, "/projects"), (HttpMethod.Put, "/projects/11111111-1111-4111-8111-111111111111"),
                (HttpMethod.Post, "/admin/assets"), (HttpMethod.Post, "/admin/assets/11111111-1111-4111-8111-111111111111/approve"),
            })
            {
                using var request = new HttpRequestMessage(method, prefix + path)
                {
                    Content = new StringContent(new string('x', 17_000), System.Text.Encoding.UTF8,
                        path == "/admin/assets" ? "model/gltf-binary" : "application/json"),
                };
                using var protectedResponse = await client.SendAsync(request);
                // Per-route larger limits survive grouping; authorization still runs before the body is read
                await Assert.That(protectedResponse.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized)
                    .Because($"{method} {prefix}{path} must retain its larger body limit");
                await AssertProblemAsync(protectedResponse, HttpStatusCode.Unauthorized, "authentication_required");
            }
        }
        foreach (var path in new[] { "/api", "/api/", "/api/v1", "/api/v1/", "/api/v2/auth/csrf", "/api/v0/auth/csrf", "/api/v01/auth/csrf",
            "/api/v1.0/auth/csrf", "/api/v10/auth/csrf", "/api/v1/missing", "/api/v1/v1/auth/csrf" })
        {
            using var get = await client.GetAsync(path);
            await AssertProblemAsync(get, HttpStatusCode.NotFound, "api_not_found");
            using var post = await client.PostAsJsonAsync(path, new { });
            await AssertProblemAsync(post, HttpStatusCode.NotFound, "api_not_found");
        }
    }

    [Test]
    public async Task Http_AllUnversionedRoutesReturnNotFoundWithoutRedirects()
    {
        await using var app = Build();
        var endpoints = ((IEndpointRouteBuilder)app).DataSources.SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>().Where(endpoint => endpoint.RoutePattern.RawText!.StartsWith("/api/v1/", StringComparison.Ordinal)).ToArray();
        await Assert.That(endpoints.Length).IsGreaterThan(0);
        await app.StartAsync();
        using var client = CreateClient(app);
        foreach (var endpoint in endpoints)
        {
            var path = Regex.Replace(endpoint.RoutePattern.RawText!, @"\{[^}]+\}", "11111111-1111-4111-8111-111111111111")
                .Replace("/api/v1/", "/api/", StringComparison.Ordinal);
            var method = new HttpMethod(endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.Single());
            foreach (var suffix in new[] { "", "/" })
            {
                using var request = new HttpRequestMessage(method, path.TrimEnd('/') + suffix);
                using var response = await client.SendAsync(request);
                await AssertProblemAsync(response, HttpStatusCode.NotFound, "api_not_found");
                await Assert.That(response.Headers.Location is null).IsTrue();
            }
        }
    }

    [Test]
    public async Task LoginRateLimit_IsSharedAcrossV1PathCasingAndTrailingSlashes()
    {
        await using var app = Build();
        await app.StartAsync();
        using var client = CreateClient(app);
        for (var index = 0; index < 60; index++)
        {
            using var response = await client.PostAsJsonAsync(index % 2 == 0 ? "/api/v1/auth/login" : "/API/V1/auth/login/", new { });
            await AssertProblemAsync(response, HttpStatusCode.BadRequest, "csrf_invalid");
        }
        using var rejected = await client.PostAsJsonAsync("/api/v1/auth/login", new { });
        await AssertProblemAsync(rejected, HttpStatusCode.TooManyRequests, "rate_limited");
        await Assert.That(rejected.Headers.RetryAfter?.Delta > TimeSpan.Zero).IsTrue();
    }

    private static WebApplication Build()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Spatia"] = "Host=127.0.0.1;Database=synthetic_configuration_only;Username=synthetic",
            ["DataProtection:KeyDirectory"] = AppContext.BaseDirectory,
            ["AllowedHosts"] = "127.0.0.1",
            ["TrustedProxies:0"] = "127.0.0.1",
        });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        return SpatiaApplication.Build(builder);
    }

    private static HttpClient CreateClient(WebApplication app)
    {
        var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        { BaseAddress = new Uri(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https");
        client.DefaultRequestHeaders.ExpectContinue = true;
        return client;
    }

    private static async Task AssertProblemAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        await Assert.That(response.StatusCode).IsEqualTo(status);
        await Assert.That(response.Content.Headers.ContentType?.MediaType).IsEqualTo("application/problem+json");
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(problem.GetProperty("code").GetString()).IsEqualTo(code);
    }
}
