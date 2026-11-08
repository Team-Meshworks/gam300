using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class ProductionRoomBrowserTests
{
    [Test]
    public async Task Browser_ApprovedStarterRoomMovesAndReopensThroughProductionApi()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(map: app =>
        {
            var directory = Path.Combine(app.Configuration["DataProtection:KeyDirectory"]!, "production-editor-static");
            Directory.CreateDirectory(directory);
            var files = new PhysicalFileProvider(directory);
            app.Lifetime.ApplicationStopped.Register(files.Dispose);
            var contentTypes = new FileExtensionContentTypeProvider();
            contentTypes.Mappings[".glb"] = "model/gltf-binary";
            app.UseStaticFiles(new StaticFileOptions { FileProvider = files, ContentTypeProvider = contentTypes });
            // The deployed web service serves public UI files before the API fallback policy.
            IResult PublicFile(string folder, string path)
            {
                var file = files.GetFileInfo($"{folder}/{path}");
                if (!file.Exists || file.IsDirectory || file.PhysicalPath is null
                    || !contentTypes.TryGetContentType(file.Name, out var type))
                {
                    return Results.NotFound();
                }
                return Results.File(file.PhysicalPath, type);
            }
            app.MapGet("/assets/{**path}", (string path) => PublicFile("assets", path)).AllowAnonymous();
            app.MapGet("/audio/{**path}", (string path) => PublicFile("audio", path)).AllowAnonymous();
            app.MapGet("/icons/{**path}", (string path) => PublicFile("icons", path)).AllowAnonymous();
            app.MapGet("/", () => Results.File(Path.Combine(directory, "index.html"), "text/html")).AllowAnonymous();
            app.MapGet("/login", () => Results.File(Path.Combine(directory, "entry.html"), "text/html"))
                .AllowAnonymous();
        }, environmentName: "Production");

        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var adminName = await AuthTestRequests.UserNameAsync(fixture, administrator);
        using (var login = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/login",
            new { userName = adminName, password = AuthTestRequests.CurrentPassword }))
        {
            await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        var bytes = await File.ReadAllBytesAsync(Path.GetFullPath(
            "../../../../../../assets/delivery/test-room.glb", AppContext.BaseDirectory));
        var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        using var manifest = JsonDocument.Parse(
            typeof(ProjectDocumentService).Assembly.GetManifestResourceStream("Spatia.Assets.Manifest")!);
        foreach (var id in new[] { "test-room-v1", "test-room-module-v1" })
        {
            var entry = manifest.RootElement.GetProperty("assets").EnumerateArray()
                .Single(asset => asset.GetProperty("assetId").GetString() == id);
            await Assert.That(entry.GetProperty("sha256").GetString()).IsEqualTo(hash);
        }
        var environment = await ApproveAsync(fixture, "environment", bytes, hash);
        var model = await ApproveAsync(fixture, "model", bytes, hash);
        await Assert.That(environment.Id).IsNotEqualTo(model.Id);
        var crateBytes = await File.ReadAllBytesAsync(Path.GetFullPath(
            "../../../../../../assets/delivery/test-crate.glb", AppContext.BaseDirectory));
        var crate = await ApproveAsync(fixture, "model", crateBytes, Convert.ToHexStringLower(SHA256.HashData(crateBytes)), "Approved sample crate.glb");
        var audioBytes = await File.ReadAllBytesAsync(Path.GetFullPath(
            "../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));
        var audio = await ApproveAsync(fixture, "audio", audioBytes, Convert.ToHexStringLower(SHA256.HashData(audioBytes)));
        using (var logout = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/logout", null))
        {
            await Assert.That(logout.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }

        var creator = await fixture.CreateAccountAsync();
        var userName = await AuthTestRequests.UserNameAsync(fixture, creator);
        using (var login = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/login",
            new { userName, password = AuthTestRequests.CurrentPassword }))
        {
            await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        using (var session = await fixture.Client.GetAsync("/api/v1/auth/session"))
        {
            await Assert.That(session.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var account = await session.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(account.GetProperty("developmentAssetsAllowed").GetBoolean()).IsFalse();
        }
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Production adjoining rooms", environmentAssetId = environment.Id.ToString() });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projectId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        using var authoring = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Production asset authoring", environmentAssetId = environment.Id.ToString() });
        await Assert.That(authoring.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var authoringId = (await authoring.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();

        var serverDirectory = Path.GetFullPath("../../../../", AppContext.BaseDirectory);
        var editorDirectory = Path.Combine(fixture.KeyDirectory, "production-editor-static");
        var artifactDirectory = Path.Combine(
            serverDirectory, ".artifacts", "production-room-browser", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(artifactDirectory);
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = serverDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        start.ArgumentList.Add(Path.Combine(serverDirectory, "tests", "production-room-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.GetLeftPart(UriPartial.Authority));
        start.ArgumentList.Add(userName);
        start.ArgumentList.Add(projectId.ToString("D"));
        start.ArgumentList.Add(environment.Id.ToString("D"));
        start.ArgumentList.Add(model.Id.ToString("D"));
        start.ArgumentList.Add(editorDirectory);
        start.ArgumentList.Add(artifactDirectory);
        start.ArgumentList.Add(JsonSerializer.Serialize(new { projectId = authoringId, crateId = crate.Id, audioId = audio.Id }));
        using var process = Process.Start(start)
            ?? throw new InvalidOperationException("Could not start the production room browser check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90));
        }
        catch
        {
            process.Kill(true);
            await process.WaitForExitAsync();
            throw;
        }
        var browserOutput = await output;
        var browserError = await error;
        await File.WriteAllTextAsync(Path.Combine(artifactDirectory, "stdout.log"), browserOutput);
        await File.WriteAllTextAsync(Path.Combine(artifactDirectory, "stderr.log"), browserError);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException("Production room browser check failed: " + browserError);
        }
        await Assert.That(browserOutput.Contains(
            "production adjoining room saved and reopened", StringComparison.Ordinal)).IsTrue();
        await Assert.That(string.IsNullOrWhiteSpace(browserError)).IsTrue();
        Console.WriteLine("Production room browser evidence: " + artifactDirectory);
    }

    private static async Task<AssetAdministrationRecord> ApproveAsync(
        HttpsApplicationFixture fixture, string kind, byte[] bytes, string hash, string? fileName = null)
    {
        var name = Uri.EscapeDataString(fileName ?? (kind == "audio" ? "Approved spatial track.m4a"
            : kind == "environment" ? "Approved Starter room.glb" : "Approved Starter model.glb"));
        var category = kind == "audio" ? "&category=BGM" : kind == "model" ? "&category=Architecture" : "";
        using var upload = new HttpRequestMessage(
            HttpMethod.Post, $"/api/v1/admin/assets?name={name}&kind={kind}{category}");
        upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        upload.Content = new ByteArrayContent(bytes);
        upload.Content.Headers.ContentType = new(AssetIntakePolicy.MediaType(kind));
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(candidate.Status).IsEqualTo("approved");
        await Assert.That(candidate.Sha256).IsEqualTo(hash);
        await Assert.That(candidate.Hidden).IsFalse();
        return candidate;
    }
}
