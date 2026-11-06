using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class PublicationPublishingBrowserTests
{
    [Test]
    public async Task Browser_ApprovedClassPublicationCommitsAndEnforcesAudience()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var (data, asset) = await PublicationEndpointTests.PrepareAsync(fixture);
        var unrelated = await fixture.CreateAccountAsync();
        var (certificate, key) = fixture.WritePemFiles();
        var serverDirectory = FindServerDirectory();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = serverDirectory,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add(Path.Combine(serverDirectory, "tests/publication-publishing-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(JsonSerializer.Serialize(new
        {
            projectId = data.ProjectId,
            assetId = asset.Id,
            assetHash = asset.Sha256,
            publicationId = Guid.NewGuid(),
            viewerId = data.OtherStudent,
            educator = await AuthTestRequests.UserNameAsync(fixture, data.Educator),
            viewer = await AuthTestRequests.UserNameAsync(fixture, data.OtherStudent),
            unrelated = await AuthTestRequests.UserNameAsync(fixture, unrelated),
            certificate,
            key,
        }));
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the publication browser check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(5)); }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        var evidence = await output;
        await Assert.That(evidence.Contains("browser publication API passed", StringComparison.Ordinal)).IsTrue();
        var artifacts = Path.Combine(serverDirectory, ".artifacts");
        Directory.CreateDirectory(artifacts);
        await File.WriteAllTextAsync(Path.Combine(artifacts, "scrum85-publication-browser.txt"), evidence);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(1);
        var edition = await database.Publications.SingleAsync();
        await fixture.App.StopAsync();
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(data.OtherStudent);
        using var snapshot = await restarted.Client.GetAsync($"/api/v1/publications/{edition.Id:D}");
        await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(edition.DocumentJson),
            JsonNode.Parse(await snapshot.Content.ReadAsStringAsync()))).IsTrue();
        using var manifest = await restarted.Client.GetAsync($"/api/v1/publications/{edition.Id:D}/manifest");
        await Assert.That(manifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var bytes = await restarted.Client.GetAsync($"/api/v1/publications/{edition.Id:D}/assets/{asset.Id:D}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(Convert.ToHexStringLower(SHA256.HashData(await bytes.Content.ReadAsByteArrayAsync())))
            .IsEqualTo(asset.Sha256);
    }

    private static string FindServerDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "apps/server");
            if (File.Exists(Path.Combine(candidate, "Spatia.Server/Spatia.Server.csproj"))) { return candidate; }
        }
        throw new InvalidOperationException("Cannot locate the server directory.");
    }
}
