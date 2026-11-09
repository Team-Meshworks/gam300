using System.Diagnostics;
using System.Text.Json;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class StarterPublicationBrowserTests
{
    [Test]
    public async Task Browser_StudentSharesStarterRoomWithAnonymousVisitors()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var (data, _) = await PublicationEndpointTests.PrepareAsync(fixture, starterRoom: true, displayCube: true);
        var (certificate, key) = fixture.WritePemFiles();
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "apps/server/Spatia.Server/Spatia.Server.csproj")))
        { directory = directory.Parent; }
        var server = Path.Combine(directory?.FullName ?? throw new InvalidOperationException("Cannot locate server."), "apps/server");
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = server,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add(Path.Combine(server, "tests/starter-publication-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(JsonSerializer.Serialize(new
        {
            projectId = data.ProjectId,
            student = await AuthTestRequests.UserNameAsync(fixture, data.Student),
            certificate,
            key,
        }));
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start browser check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(5)); }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        await Assert.That((await output).Contains("starter publication browser passed", StringComparison.Ordinal)).IsTrue();
    }
}
