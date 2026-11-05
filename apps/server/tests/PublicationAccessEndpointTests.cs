using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Npgsql;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class PublicationAccessEndpointTests
{
    [Test]
    public async Task PolicyChange_ExpiryBeforeCommitRollsBackTheChange()
    {
        var probe = new ExpireAfterSave();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)), environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var publication = data.GetProperty("publicationId").GetGuid();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("manager").GetProperty("userId").GetGuid());
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/publications/{publication}/access")
        {
            Content = JsonContent.Create(new { audience = "Authenticated", viewerIds = Array.Empty<Guid>(), action = "hide" }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        probe.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == publication)).Hidden).IsFalse();
    }

    [Test]
    public async Task Delivery_HeadUsesTheSameAuthorityAndMetadataWithoutABody()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var publication = data.GetProperty("publicationId").GetGuid();
        var asset = data.GetProperty("assetId").GetGuid();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("viewer").GetProperty("userId").GetGuid());
        using var anonymous = fixture.CreateClient();
        foreach (var path in new[] { $"/api/publications/{publication}", $"/api/publications/{publication}/assets/{asset}/bytes" })
        {
            using var get = await fixture.Client.GetAsync(path);
            using var headRequest = new HttpRequestMessage(HttpMethod.Head, path);
            using var head = await fixture.Client.SendAsync(headRequest);
            await Assert.That(get.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(head.StatusCode).IsEqualTo(get.StatusCode);
            await Assert.That(head.Content.Headers.ContentType?.ToString()).IsEqualTo(get.Content.Headers.ContentType?.ToString());
            await Assert.That(head.Content.Headers.ContentLength).IsEqualTo(get.Content.Headers.ContentLength);
            await Assert.That(head.Headers.CacheControl?.NoStore).IsTrue();
            await Assert.That((await head.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
            using var deniedRequest = new HttpRequestMessage(HttpMethod.Head, path);
            using var denied = await anonymous.SendAsync(deniedRequest);
            await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
            await Assert.That(denied.Headers.CacheControl?.NoStore).IsTrue();
            await Assert.That((await denied.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
        }
    }

    private sealed class ExpireAfterSave : SaveChangesInterceptor
    {
        public Action? After;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }

    [Test]
    public async Task Browser_PublicationAudienceLifecycleAndProtectedBytesUseCurrentAuthority()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        var serverDirectory = FindServerDirectory();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = serverDirectory,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add(Path.Combine(serverDirectory, "tests/publication-access-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(JsonSerializer.Serialize(data));
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the publication browser check");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(5)); }
        catch (Exception exception)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            if (exception is TimeoutException)
            {
                throw new TimeoutException($"Browser check timed out. stdout: {await output}; stderr: {await error}", exception);
            }
            throw;
        }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        var evidence = await output;
        await Assert.That(evidence.Contains("publication access matrix passed", StringComparison.Ordinal)).IsTrue();
        var artifacts = Path.Combine(serverDirectory, ".artifacts");
        Directory.CreateDirectory(artifacts);
        await File.WriteAllTextAsync(Path.Combine(artifacts, "scrum71-publication-browser.txt"), evidence);

        // Visitor and management operations keep immutable editions and retained asset bytes intact
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(4);
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync(row => row.Deleted)).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync(row => row.Revoked)).IsEqualTo(1);
    }

    [Test]
    public async Task AudienceChange_UnresolvedPublicModesCannotExposeAnAuthenticatedEdition()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var publication = data.GetProperty("publicationId").GetGuid();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("publisher").GetProperty("userId").GetGuid());
        foreach (var audience in new[] { "Public", "Unlisted" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/publications/{publication}/access")
            {
                Content = JsonContent.Create(new { audience, viewerIds = Array.Empty<Guid>(), action = "audience" }),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var response = await fixture.Client.SendAsync(request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        }
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var state = await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == publication);
        await Assert.That(state.Audience).IsEqualTo(3);
        await Assert.That(state.ViewerIds.Length).IsEqualTo(1);
        using var anonymous = fixture.CreateClient();
        using var denied = await anonymous.GetAsync($"/api/publications/{publication}");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task AudienceChange_WaitingForProjectLockRechecksRemovedPublisherAuthority()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var projectId = data.GetProperty("projectId").GetGuid();
        var publicationId = data.GetProperty("publicationId").GetGuid();
        var publisher = data.GetProperty("actors").GetProperty("publisher").GetProperty("userId").GetGuid();
        await fixture.SignInAsync(publisher);
        var csrf = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var held = await database.Database.BeginTransactionAsync();
        await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM projects WHERE id = {projectId} FOR UPDATE").ToListAsync();

        // Force the HTTP request to wait after its preliminary permission check
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/publications/{publicationId}/access");
        request.Headers.Add("X-CSRF-TOKEN", csrf);
        request.Content = JsonContent.Create(new { audience = "Public", viewerIds = Array.Empty<Guid>(), action = "audience" });
        var pending = fixture.Client.SendAsync(request);
        var released = false;
        try
        {
            await using var observerScope = fixture.Database.Services.CreateAsyncScope();
            var observer = (NpgsqlConnection)observerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetDbConnection();
            await observer.OpenAsync();
            await using var blocked = new NpgsqlCommand("SELECT count(*) FROM pg_stat_activity WHERE application_name = @name AND wait_event_type = 'Lock'", observer);
            blocked.Parameters.AddWithValue("name", "Spatia.Part3." + fixture.Database.SchemaName);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((long)(await blocked.ExecuteScalarAsync(timeout.Token) ?? 0L) == 0)
            {
                await Task.Delay(10, timeout.Token);
            }

            // Commit the competing grant removal before allowing the queued policy change to continue
            await database.ProjectAssignments.Where(row => row.ProjectId == projectId && row.UserId == publisher).ExecuteDeleteAsync();
            await held.CommitAsync();
            released = true;
        }
        finally
        {
            if (!released) { await held.RollbackAsync(); }
        }
        using var response = await pending;
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        var retained = await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == publicationId);
        await Assert.That(retained.Audience).IsEqualTo(3);
        await Assert.That(retained.ViewerIds.Length).IsEqualTo(1);
    }

    private static async Task<object> SeedAsync(HttpsApplicationFixture fixture)
    {
        var publisher = await fixture.CreateAccountAsync();
        var viewer = await fixture.CreateAccountAsync();
        var unrelated = await fixture.CreateAccountAsync();
        var manager = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var foreign = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await database.OrganizationMemberships.Where(row => row.UserId == publisher)
            .Select(row => row.OrganizationId).SingleAsync();

        // Put named and unrelated students in the same organization without granting either draft access
        await database.OrganizationMemberships.Where(row => row.UserId == viewer || row.UserId == unrelated || row.UserId == manager)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = "Retained publication room",
            Kind = "environment",
            Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            Bytes = bytes,
            Status = "approved",
            Hidden = true,
            Deleted = true,
            ValidationJson = "{}",
            Source = "Synthetic test material",
            License = "Synthetic fixture",
            ReviewNotes = "Fixture-only approval",
            SubmittedBy = admin,
            ReviewedBy = admin,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        database.AssetCandidates.Add(asset);
        var projectId = Guid.NewGuid();
        var document = JsonNode.Parse(ProjectTestDocuments.Create(projectId, "Protected publication snapshot"))!;
        document["scenes"]![0]!["environmentAssetId"] = asset.Id.ToString("D");
        document["scenes"]![0]!["objects"] = new JsonArray();
        database.Projects.Add(new Project
        {
            Id = projectId,
            OrganizationId = organization,
            DocumentJson = document.ToJsonString(),
            SchemaVersion = 1,
            Revision = 0,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        database.ProjectAssignments.AddRange(
            new ProjectAssignment { ProjectId = projectId, UserId = publisher, CanEdit = true, CanPublish = true },
            new ProjectAssignment { ProjectId = projectId, UserId = manager, CanEdit = true, CanManage = true, CanPublish = true });
        await database.SaveChangesAsync();

        // Seed real immutable storage; all subsequent reads and permission changes go through production HTTP routes
        var publicationId = Guid.NewGuid();
        var deletedId = Guid.NewGuid();
        var publicId = Guid.NewGuid();
        var unlistedId = Guid.NewGuid();
        foreach (var (id, audience) in new[] { (publicationId, 3), (deletedId, 3), (publicId, 1), (unlistedId, 2) })
        {
            database.Publications.Add(new Publication
            {
                Id = id,
                ProjectId = projectId,
                PublishedById = publisher,
                SourceRevision = 0,
                SchemaVersion = 1,
                DocumentJson = document.ToJsonString(),
                RequestDigest = new byte[32],
                AssetReferencesJson = PublicationAssetManifest.Serialize([new(asset.Id.ToString("D"), asset.Sha256)]),
            });
            database.PublicationAccess.Add(new PublicationAccessState { PublicationId = id, Audience = audience, ViewerIds = [viewer] });
        }
        await database.SaveChangesAsync();
        var actors = new Dictionary<string, object>();
        foreach (var (name, id) in new[] { ("publisher", publisher), ("viewer", viewer), ("unrelated", unrelated),
            ("manager", manager), ("admin", admin), ("foreign", foreign) })
        {
            actors[name] = new { userId = id, userName = await AuthTestRequests.UserNameAsync(fixture, id) };
        }
        return new { projectId, publicationId, deletedId, publicId, unlistedId, assetId = asset.Id, actors };
    }

    private static string FindServerDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "apps/server");
            if (File.Exists(Path.Combine(candidate, "tests/publication-access-browser.check.mjs"))) { return candidate; }
        }
        throw new InvalidOperationException("Cannot locate the publication browser check");
    }
}
