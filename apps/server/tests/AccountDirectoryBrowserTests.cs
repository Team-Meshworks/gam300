using System.Diagnostics;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountDirectoryBrowserTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Directory_BrowserCreatesAndOverridesRealAccounts(bool forced)
    {
        // Use the development catalogue so the seeded project document can be validated on read.
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator, forced);
        var creator = await fixture.CreateAccountAsync();
        await using (var seed = fixture.App.Services.CreateAsyncScope())
        {
            var database = seed.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var projectId = Guid.NewGuid();
            database.Projects.Add(new Project
            {
                Id = projectId,
                OrganizationId = await database.OrganizationMemberships.Where(row => row.UserId == creator)
                    .Select(row => row.OrganizationId).SingleAsync(),
                SchemaVersion = 1,
                DocumentJson = ProjectTestDocuments.Create(projectId, "Dashboard browser project", 1),
                Revision = 0,
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            await database.SaveChangesAsync();
        }
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
        start.Environment["SPATIA_TEST_FORCED_ADMIN"] = forced ? "true" : "false";
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
