using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class ReviewScreensIntegrationTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ReviewScreens_UseAuthorizedSavedRevisionsAndReportUnavailableAssets(bool unavailableAssets)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var seeded = await ReviewSubmissionEndpointTests.SeedAsync(fixture, late: true);
        if (!unavailableAssets)
        {
            fixture.App.Configuration["Publication:Origin"] = "https://publications.example.test";
            var bytes = AssetIntakeTests.CreateMinimalGlb();
            await using var assetScope = fixture.App.Services.CreateAsyncScope();
            var database = assetScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var asset = new AssetCandidate
            {
                Id = Guid.NewGuid(), Name = "Synthetic room", Kind = "environment", Bytes = bytes,
                Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), Status = "approved", ValidationJson = "{}",
                Source = "Synthetic fixture", License = "Synthetic test only", ReviewNotes = "Fixture approval",
                SubmittedBy = seeded.Educator, ReviewedBy = seeded.Educator, CreatedAt = DateTimeOffset.UtcNow,
            };
            database.AssetCandidates.Add(asset);
            var project = await database.Projects.SingleAsync(row => row.Id == seeded.ProjectId);
            var document = JsonNode.Parse(project.DocumentJson)!;
            document["scenes"]![0]!["environmentAssetId"] = asset.Id.ToString();
            document["scenes"]![0]!["objects"] = new JsonArray();
            project.DocumentJson = document.ToJsonString();
            await database.SaveChangesAsync();
        }
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
