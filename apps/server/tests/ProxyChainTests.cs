using System.Diagnostics;
using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class ProxyChainTests
{
    [Test]
    public async Task TwoCaddyHops_PreserveClientIdentityAndSeparateAuthenticationBudgets()
    {
        var directory = Path.Combine(Path.GetTempPath(), "spatia-proxy-keys-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
            builder.Configuration.Sources.Clear();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Spatia"] = "Host=127.0.0.1;Database=configuration_only;Username=synthetic",
                ["DataProtection:KeyDirectory"] = directory,
                ["AllowedHosts"] = "localhost",
                ["TrustedProxies:0"] = "127.0.0.1",
            });
            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
            await using var app = SpatiaApplication.Build(builder);
            app.MapGet("/api/v1/probe", (HttpContext context) => Results.Json(new
            {
                address = context.Connection.RemoteIpAddress?.ToString(),
                scheme = context.Request.Scheme,
            })).AllowAnonymous();
            app.MapGet("/api/v1/rate", () => Results.NoContent()).AllowAnonymous()
                .RequireRateLimiting(SecurityPolicies.AuthenticationRateLimit);
            await app.StartAsync();
            try
            {
                var root = new DirectoryInfo(AppContext.BaseDirectory);
                while (root is not null && !File.Exists(Path.Combine(root.FullName, "deploy", "proxy-chain.check.mjs")))
                {
                    root = root.Parent;
                }
                if (root is null)
                {
                    throw new InvalidOperationException("Cannot locate proxy integration check.");
                }
                var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
                {
                    WorkingDirectory = root.FullName,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                start.ArgumentList.Add(Path.Combine(root.FullName, "deploy", "proxy-chain.check.mjs"));
                start.Environment["SPATIA_PROXY_TEST_API_PORT"] = new Uri(app.Urls.Single()).Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
                start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
                start.Environment.Remove("ConnectionStrings__Spatia");
                using var process = Process.Start(start) ?? throw new InvalidOperationException("Cannot start proxy integration check.");
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                try
                {
                    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(45));
                }
                catch
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                    throw;
                }
                await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
            }
            finally
            {
                await app.StopAsync();
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
