using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.HostFiltering;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Hosting;

public static class SpatiaApplication
{
    private const long MaxRequestBodyBytes = 16 * 1024;

    public static WebApplication Build(WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var connectionString = RequireSetting(builder.Configuration, "ConnectionStrings:Spatia");
        try
        {
            var connection = new NpgsqlConnectionStringBuilder(connectionString);
            if (string.IsNullOrWhiteSpace(connection.Host)
                || string.IsNullOrWhiteSpace(connection.Database)
                || string.IsNullOrWhiteSpace(connection.Username))
            {
                throw new ArgumentException();
            }
        }
        catch (ArgumentException)
        {
            throw new InvalidOperationException("ConnectionStrings:Spatia must specify a valid database connection.");
        }

        var keyDirectory = RequireSetting(builder.Configuration, "DataProtection:KeyDirectory");
        if (!Path.IsPathFullyQualified(keyDirectory) || !Directory.Exists(keyDirectory))
        {
            throw new InvalidOperationException("DataProtection:KeyDirectory must be an absolute existing protected directory.");
        }

        var allowedHosts = RequireSetting(builder.Configuration, "AllowedHosts")
            .Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (allowedHosts.Length == 0 || allowedHosts.Any(host => host.Contains('*')
            || Uri.CheckHostName(host) == UriHostNameType.Unknown
            || (IPAddress.TryParse(host.Trim('[', ']'), out var address)
                && (address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)))))
        {
            throw new InvalidOperationException("AllowedHosts must specify explicit hosts without wildcards.");
        }

        var automaticForwarding = builder.Configuration["ForwardedHeaders_Enabled"];
        if (!string.IsNullOrWhiteSpace(automaticForwarding)
            && (!bool.TryParse(automaticForwarding, out var enabled) || enabled))
        {
            throw new InvalidOperationException("Automatic forwarded headers are disabled; configure TrustedProxies explicitly.");
        }

        var forwardedHeaders = new ForwardedHeadersOptions
        {
            ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
            ForwardLimit = 1,
        };
        forwardedHeaders.KnownProxies.Clear();
        forwardedHeaders.KnownIPNetworks.Clear();
        foreach (var proxy in builder.Configuration.GetSection("TrustedProxies").GetChildren())
        {
            if (!IPAddress.TryParse(proxy.Value, out var address))
            {
                throw new InvalidOperationException("TrustedProxies must contain explicit IP addresses.");
            }

            forwardedHeaders.KnownProxies.Add(address);
        }

        builder.Services.PostConfigure<LoggerFilterOptions>(options =>
        {
            string[] privateCategories = ["Microsoft.AspNetCore", "Microsoft.EntityFrameworkCore", "Npgsql"];
            for (var index = 0; index < options.Rules.Count; index++)
            {
                var rule = options.Rules[index];
                options.Rules[index] = new LoggerFilterRule(rule.ProviderName, rule.CategoryName, rule.LogLevel,
                    (provider, category, level) => (category is null
                        || !privateCategories.Any(prefix => category.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                        && (rule.Filter?.Invoke(provider, category, level) ?? true));
            }

            foreach (var category in privateCategories)
            {
                options.Rules.Add(new LoggerFilterRule(null, category, LogLevel.None, null));
            }
        });
        builder.Services.Configure<HostFilteringOptions>(options =>
        {
            options.AllowedHosts = allowedHosts;
            options.AllowEmptyHosts = false;
            options.IncludeFailureMessage = false;
        });
        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = MaxRequestBodyBytes);
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            options.SerializerOptions.PropertyNameCaseInsensitive = false;
            options.SerializerOptions.AllowDuplicateProperties = false;
            options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
        });
        builder.Services.AddScoped<AccountAdministrationService>();
        builder.Services.AddScoped<AccountSessionService>();
        builder.Services.AddSpatiaAccounts(connectionString);
        builder.Services.AddSpatiaRequestSecurity();
        builder.Services.AddDataProtection()
            .PersistKeysToFileSystem(new DirectoryInfo(keyDirectory))
            .SetApplicationName($"Spatia:{builder.Environment.EnvironmentName}");
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<SafeApiExceptionHandler>();

        var app = builder.Build();
        app.Use(async (context, next) =>
        {
            var startedAt = Stopwatch.GetTimestamp();
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                await next(context);
            }
            catch (Exception)
            {
                // Exceptions after headers start cannot become safe problem responses
                app.Logger.LogError("response_aborted {TraceId}", context.TraceIdentifier);
                context.Abort();
            }
            finally
            {
                var endpoint = context.GetEndpoint()
                    ?? context.Features.Get<IExceptionHandlerFeature>()?.Endpoint;
                var route = (endpoint as RouteEndpoint)?.RoutePattern.RawText ?? "unmatched";
                app.Logger.LogInformation("request_completed {Method} {Endpoint} {StatusCode} {DurationMs} {TraceId}",
                    context.Request.Method, route, context.Response.StatusCode,
                    Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, context.TraceIdentifier);
            }
        });
        app.UseExceptionHandler(new ExceptionHandlerOptions { SuppressDiagnosticsCallback = _ => true });
        if (forwardedHeaders.KnownProxies.Count != 0)
        {
            app.UseForwardedHeaders(forwardedHeaders);
        }

        app.UseStatusCodePages(async statusContext =>
        {
            var context = statusContext.HttpContext;
            var status = context.Response.StatusCode;
            await ApiProblems.Create(context, status, $"http_{status}", ReasonPhrases.GetReasonPhrase(status))
                .ExecuteAsync(context);
        });
        app.Use(async (context, next) =>
        {
            if (!context.Request.IsHttps)
            {
                await ApiProblems.Create(context, 400, "https_required", "HTTPS is required").ExecuteAsync(context);
                return;
            }

            if (context.Request.ContentLength > MaxRequestBodyBytes)
            {
                await ApiProblems.Create(context, 413, "request_too_large", "The request is too large").ExecuteAsync(context);
                return;
            }

            await next(context);
        });
        app.UseRouting();
        app.UseAuthentication();
        app.UseRateLimiter();
        app.UseAuthorization();
        app.UseSpatiaAntiforgery();
        app.MapGet("/api/auth/csrf", (HttpContext context, IAntiforgery antiforgery) =>
        {
            var tokens = antiforgery.GetAndStoreTokens(context);
            return Results.Ok(new { requestToken = tokens.RequestToken });
        }).AllowAnonymous();
        app.MapAccountAdministration();
        app.MapAccountSessions();
        return app;
    }

    private static string RequireSetting(IConfiguration configuration, string key)
    {
        var value = configuration[key];
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"Required configuration {key} is missing.");
        }

        return value;
    }
}
