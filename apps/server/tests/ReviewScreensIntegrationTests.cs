using System.Diagnostics;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ReviewScreensIntegrationTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ReviewScreens_UseAuthorizedSavedRevisionsAndReportUnavailableAssets(bool unavailableAssets)
    {
        await using var fixture = unavailableAssets
            ? await HttpsApplicationFixture.CreateAsync(environmentName: "Development")
            : await ReviewSubmissionEndpointTests.CreateFixtureAsync(new());
        var seeded = await ReviewSubmissionEndpointTests.SeedAsync(fixture, late: true);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var student = (await users.FindByIdAsync(seeded.Student.ToString("D")))!;
        var educator = (await users.FindByIdAsync(seeded.Educator.ToString("D")))!;
        var files = fixture.WritePemFiles();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(FindRoot(), "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/review-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_REVIEW_STUDENT"] = student.UserName!;
        start.Environment["SPATIA_REVIEW_EDUCATOR"] = educator.UserName!;
        start.Environment["SPATIA_REVIEW_PROJECT"] = seeded.ProjectId.ToString("D");
        start.Environment["SPATIA_REVIEW_CLASS"] = seeded.ClassroomId.ToString("D");
        start.Environment["SPATIA_REVIEW_UNAVAILABLE"] = unavailableAssets ? "true" : "false";
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start review browser test.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(120));
        }
        catch
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw;
        }
        var diagnostic = await output + await error;
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(diagnostic);
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
