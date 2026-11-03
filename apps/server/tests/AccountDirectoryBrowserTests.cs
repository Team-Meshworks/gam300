using System.Diagnostics;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountDirectoryBrowserTests
{
    [Test]
    public async Task Directory_BrowserCreatesAndOverridesRealAccounts()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.CreateAccountAsync();
        var files = fixture.WritePemFiles();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "apps", "web", "vite.config.ts")))
        {
            root = root.Parent;
        }

        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root!.FullName, "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/account-directory-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_ADMIN"] = await AuthTestRequests.UserNameAsync(fixture, administrator);
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90)); }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var created = (await users.FindByNameAsync("browser.updated"))!;
        await Assert.That(created.DisplayName).IsEqualTo("Browser Updated");
        await Assert.That(await users.CheckPasswordAsync(created, "Browser-replacement2!")).IsTrue();
        await Assert.That((await users.GetRolesAsync(created)).Single()).IsEqualTo(ApplicationRoles.Educator);
    }
}
