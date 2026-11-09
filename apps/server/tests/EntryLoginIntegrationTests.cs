using System.Diagnostics;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class EntryLoginIntegrationTests
{
    [Test]
    public async Task LoginPage_UsesRealHttpsApiAndPersistsPasswordChange()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator, forced: true);
        var creator = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var admin = (await manager.FindByIdAsync(administrator.ToString("D")))!;
        var normal = (await manager.FindByIdAsync(creator.ToString("D")))!;
        var files = fixture.WritePemFiles();
        var root = FindRoot();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root, "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/login-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_ADMIN"] = admin.UserName!;
        start.Environment["SPATIA_TEST_CREATOR"] = normal.UserName!;
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start browser test.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90));
        }
        catch
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw;
        }
        var diagnostic = await output + await error;
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(diagnostic);
        // Reload from a new scope after the browser process completed its database-backed change.
        await using var verifyScope = fixture.Database.Services.CreateAsyncScope();
        var verifyManager = verifyScope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var persisted = (await verifyManager.FindByIdAsync(administrator.ToString("D")))!;
        await Assert.That(persisted.MustChangePassword).IsFalse();
        await Assert.That(await verifyManager.CheckPasswordAsync(persisted, "Synthetic-replacement-password2!")).IsTrue();
        await Assert.That(await verifyManager.CheckPasswordAsync(persisted, "Synthetic-long-password1!")).IsFalse();
    }

    private static string FindRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "apps", "web", "vite.config.ts")))
            {
                return directory.FullName;
            }
        }
        throw new InvalidOperationException("Cannot locate the repository root.");
    }
}
