using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(BuiltInPublicationTests))]
public sealed class BuiltInPublicationTests
{
    [Test]
    public async Task Development_ApprovedStudentPublishesStarterRoomForAnonymousVisitors()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        fixture.App.Configuration["Publication:Origin"] = "https://publications.example.test";
        using var source = new TemporaryStarterAsset();
        fixture.App.Configuration["DevelopmentPublication:AssetDirectory"] = source.DirectoryPath;
        var data = await ReviewSubmissionEndpointTests.SeedAsync(fixture, false);
        var modelBytes = AssetIntakeTests.CreateMinimalGlb();
        var modelId = Guid.NewGuid();
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.AssetCandidates.Add(new AssetCandidate
            {
                Id = modelId,
                Name = "Approved model",
                Kind = "model",
                Bytes = modelBytes,
                Sha256 = Convert.ToHexStringLower(SHA256.HashData(modelBytes)),
                Status = "approved",
                ValidationJson = "{}",
                Source = "Test",
                License = "Test",
                ReviewNotes = "Test",
                SubmittedBy = data.Educator,
                ReviewedBy = data.Educator,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            var project = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
            var document = JsonNode.Parse(project.DocumentJson)!;
            document["scenes"]![0]!["environmentAssetId"] = "test-room-v1";
            foreach (var item in document["scenes"]![0]!["objects"]!.AsArray()) { item!["assetId"] = modelId.ToString(); }
            project.DocumentJson = document.ToJsonString();
            await database.SaveChangesAsync();
        }
        var submissionId = Guid.NewGuid();
        using (var submitted = await ReviewSubmissionEndpointTests.SubmitAsync(fixture, data.ProjectId, submissionId, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        await fixture.SignInAsync(data.Educator);
        using (var decision = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{data.ProjectId:D}/submissions/{submissionId:D}/decisions")
        { Content = JsonContent.Create(new { decisionId = Guid.NewGuid(), expectedRevision = 0, outcome = "approved", feedback = "Ready" }) })
        {
            decision.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var approved = await fixture.Client.SendAsync(decision);
            await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
        await fixture.SignInAsync(data.Student);
        var publicationId = Guid.NewGuid();
        using (var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{data.ProjectId:D}/publications")
        { Content = JsonContent.Create(new { publicationId, confirmedRevision = 0, intent = new { audience = "Unlisted", viewerIds = Array.Empty<Guid>() } }) })
        {
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var published = await fixture.Client.SendAsync(request);
            await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created)
                .Because(await published.Content.ReadAsStringAsync());
        }
        using var visitor = fixture.CreateClient();
        using var snapshot = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}");
        await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var manifest = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}/manifest");
        await Assert.That(manifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var assets = (await manifest.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("assets").EnumerateArray().ToArray();
        await Assert.That(assets.Length).IsEqualTo(2);
        var asset = assets.Single(row => row.GetProperty("id").GetString() == "test-room-v1");
        await Assert.That(asset.GetProperty("id").GetString()).IsEqualTo("test-room-v1");
        using var bytes = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}/assets/test-room-v1/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(Convert.ToHexStringLower(SHA256.HashData(await bytes.Content.ReadAsByteArrayAsync())))
            .IsEqualTo(asset.GetProperty("sha256").GetString());
        using var approvedBytes = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}/assets/{modelId:D}/bytes");
        await Assert.That(approvedBytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await approvedBytes.Content.ReadAsByteArrayAsync()).SequenceEqual(modelBytes)).IsTrue();
        var secondPublication = Guid.NewGuid();
        using (var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{data.ProjectId:D}/publications")
        { Content = JsonContent.Create(new { publicationId = secondPublication, confirmedRevision = 0, intent = new { audience = "Unlisted", viewerIds = Array.Empty<Guid>() } }) })
        {
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var published = await fixture.Client.SendAsync(request);
            await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM development_publication_blobs").SingleAsync()).IsEqualTo(1);
            await Assert.That(await database.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM development_publication_assets").SingleAsync()).IsEqualTo(2);
        }
        await File.WriteAllBytesAsync(source.FilePath, [1, 2, 3]);
        using var retained = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}/assets/test-room-v1/bytes");
        await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(Convert.ToHexStringLower(SHA256.HashData(await retained.Content.ReadAsByteArrayAsync())))
            .IsEqualTo(asset.GetProperty("sha256").GetString());
        using var readiness = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId:D}/publication-readiness");
        await Assert.That((await readiness.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("state").GetString())
            .IsEqualTo("InvalidAssets");
        await using var production = await fixture.CreateSiblingAsync(_ => { }, "Production");
        using var denied = await production.Client.GetAsync($"/api/v1/publications/{publicationId:D}");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var unknown = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}/assets/unknown-room/bytes");
        await Assert.That(unknown.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await using var transaction = await database.Database.BeginTransactionAsync();
            var error = await Assert.ThrowsAsync<PostgresException>(async () =>
                await database.Database.ExecuteSqlRawAsync("UPDATE development_publication_blobs SET bytes = decode('00', 'hex')"));
            await Assert.That(error!.SqlState).IsEqualTo("23514");
            await transaction.RollbackAsync();
        }
        await fixture.SignInAsync(data.Educator);
        using (var revoke = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{publicationId:D}/access")
        { Content = JsonContent.Create(new { audience = "Unlisted", viewerIds = Array.Empty<Guid>(), action = "revoke" }) })
        {
            revoke.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var revoked = await fixture.Client.SendAsync(revoke);
            await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        using var afterRevocation = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}/assets/test-room-v1/bytes");
        await Assert.That(afterRevocation.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var otherEdition = await visitor.GetAsync($"/api/v1/publications/{secondPublication:D}/assets/test-room-v1/bytes");
        await Assert.That(otherEdition.StatusCode).IsEqualTo(HttpStatusCode.OK);
    }

    private sealed class TemporaryStarterAsset : IDisposable
    {
        internal string DirectoryPath { get; } = Path.Combine(Path.GetTempPath(), "spatia-publication-assets-" + Guid.NewGuid().ToString("N"));
        internal string FilePath => Path.Combine(DirectoryPath, "test-room.glb");

        internal TemporaryStarterAsset()
        {
            Directory.CreateDirectory(DirectoryPath);
            File.Copy(Path.Combine(AppContext.BaseDirectory, "development-assets", "test-room.glb"), FilePath);
        }

        public void Dispose()
        {
            File.Delete(FilePath);
            Directory.Delete(DirectoryPath);
        }
    }
}
