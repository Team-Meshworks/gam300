using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class PublicationEndpointTests
{
    [Test]
    public async Task Publish_ApprovedClassEditionCommitsPolicyBytesAndRetryWithoutChangingDraft()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, asset) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, id, viewers: [data.OtherStudent]);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var ack = await published.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(ack.GetProperty("publicationId").GetGuid()).IsEqualTo(id);
        await Assert.That(ack.GetProperty("sourceRevision").GetInt64()).IsEqualTo(0);
        await Assert.That(ack.GetProperty("visitorUrl").GetString()).IsEqualTo($"https://publications.example.test/p/{id:D}");
        using var manifest = await fixture.Client.GetAsync($"/api/publications/{id}/manifest");
        await Assert.That(manifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var manifestBody = await manifest.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(manifestBody.GetProperty("assets")[0].GetProperty("id").GetString()).IsEqualTo(asset.Id.ToString("D"));
        await Assert.That(manifestBody.GetProperty("assets")[0].GetProperty("sha256").GetString()).IsEqualTo(asset.Sha256);
        await Assert.That(ack.GetProperty("snapshotUrl").GetString()).IsEqualTo($"https://publications.example.test/api/publications/{id:D}");
        using var snapshot = await fixture.Client.GetAsync($"/api/publications/{id}");
        await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var original = await snapshot.Content.ReadAsStringAsync();
        using var bytes = await fixture.Client.GetAsync($"/api/publications/{id}/assets/{asset.Id}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await bytes.Content.ReadAsByteArrayAsync()).SequenceEqual(asset.Bytes)).IsTrue();
        using var replay = await PublishAsync(fixture, data.ProjectId, id, viewers: [data.OtherStudent]);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await fixture.SignInAsync(data.OtherStudent);
        using var named = await fixture.Client.GetAsync($"/api/publications/{id}");
        await Assert.That(named.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var namedManifest = await fixture.Client.GetAsync($"/api/publications/{id}/manifest");
        await Assert.That(namedManifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(namedManifest.Headers.CacheControl?.NoStore).IsTrue();
        using var draft = await fixture.Client.GetAsync($"/api/projects/{data.ProjectId}");
        await Assert.That(draft.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var denied = await fixture.Client.GetAsync($"/api/publications/{id}");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var deniedManifest = await fixture.Client.GetAsync($"/api/publications/{id}/manifest");
        await Assert.That(deniedManifest.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(1);
        var project = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
        await Assert.That(project.Revision).IsEqualTo(0);
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(original), JsonNode.Parse(project.DocumentJson))).IsTrue();
    }

    [Test]
    public async Task Publish_ReplayCannotRestoreRevocationOrChangeTheOriginalIntent()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        using var created = await PublishAsync(fixture, data.ProjectId, id);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var changed = await PublishAsync(fixture, data.ProjectId, id, viewers: [data.OtherStudent]);
        await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/publications/{id}/access")
        {
            Content = JsonContent.Create(new { audience = "Authenticated", viewerIds = Array.Empty<Guid>(), action = "revoke" }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var revoked = await fixture.Client.SendAsync(request);
        await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var retry = await PublishAsync(fixture, data.ProjectId, id);
        await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var hidden = await fixture.Client.GetAsync($"/api/publications/{id}");
        await Assert.That(hidden.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var hiddenManifest = await fixture.Client.GetAsync($"/api/publications/{id}/manifest");
        await Assert.That(hiddenManifest.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That((await database.PublicationAccess.SingleAsync()).Revoked).IsTrue();
    }

    [Test]
    public async Task Publish_PolicyStorageFailureRollsBackTheImmutableEdition()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        // Inject a storage failure only in this fixture's isolated schema, after the edition insert
        await database.Database.ExecuteSqlRawAsync("""
            CREATE FUNCTION reject_test_publication_policy() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'Synthetic policy storage failure'; END; $$;
            CREATE TRIGGER test_reject_publication_policy BEFORE INSERT ON publication_access
                FOR EACH ROW EXECUTE FUNCTION reject_test_publication_policy();
            """);
        using var response = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid());
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(problem.GetProperty("code").GetString()).IsEqualTo("storage_unavailable");
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Publish_RejectsMalformedIntentMissingCsrfAndAccountSwitchWithoutWrites()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var path = $"/api/projects/{data.ProjectId}/publications";
        var id = Guid.NewGuid();
        foreach (var intent in new[]
        {
            "{}", "{\"audience\":\"Authenticated\",\"viewerIds\":[],\"extra\":true}",
            "{\"audience\":\"Authenticated\",\"viewerIds\":[null]}",
        })
        {
            using var parsed = JsonDocument.Parse(intent);
            using var request = new HttpRequestMessage(HttpMethod.Post, path)
            {
                Content = JsonContent.Create(new { publicationId = id, confirmedRevision = 0, intent = parsed.RootElement }),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var response = await fixture.Client.SendAsync(request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        }
        var body = new { publicationId = id, confirmedRevision = 0, intent = new { audience = "Authenticated", viewerIds = Array.Empty<Guid>() } };
        using var noCsrf = await fixture.Client.PostAsJsonAsync(path, body);
        await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var stale = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        stale.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        stale.Headers.Add("X-Spatia-Account", data.Student.ToString());
        using var switched = await fixture.Client.SendAsync(stale);
        await Assert.That(switched.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments("approval", 409)]
    [Arguments("origin", 503)]
    [Arguments("public", 503)]
    [Arguments("unlisted", 503)]
    [Arguments("asset", 422)]
    [Arguments("revision", 409)]
    [Arguments("viewer", 403)]
    [Arguments("configuration", 503)]
    public async Task Publish_UnreadyDependenciesNeverLeavePartialEditions(string reason, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, asset) = await PrepareAsync(fixture, approve: reason != "approval");
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (reason == "origin")
            {
                var original = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
                var id = Guid.NewGuid();
                var document = JsonNode.Parse(original.DocumentJson)!;
                document["projectId"] = id.ToString();
                database.Projects.Add(new Project
                {
                    Id = id,
                    OrganizationId = original.OrganizationId,
                    DocumentJson = document.ToJsonString(),
                    SchemaVersion = 1,
                    UpdatedAt = DateTimeOffset.UtcNow,
                });
                database.ProjectAssignments.Add(new ProjectAssignment
                {
                    ProjectId = id,
                    UserId = data.Educator,
                    CanEdit = true,
                    CanManage = true,
                    CanPublish = true,
                });
                await database.SaveChangesAsync();
                data = data with { ProjectId = id };
            }
            if (reason == "asset")
            {
                await database.AssetCandidates.Where(row => row.Id == asset.Id).ExecuteUpdateAsync(set =>
                    set.SetProperty(row => row.Hidden, true).SetProperty(row => row.Deleted, true).SetProperty(row => row.RemovedFromProjects, true));
            }
        }
        if (reason == "configuration") { fixture.App.Configuration["Publication:Origin"] = "http://unsafe.example.test"; }
        var audience = reason == "public" ? "Public" : reason == "unlisted" ? "Unlisted" : "Authenticated";
        var viewers = reason == "viewer" ? new[] { Guid.NewGuid() } : Array.Empty<Guid>();
        using var response = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid(), audience, viewers, reason == "revision" ? 1 : 0);
        await Assert.That((int)response.StatusCode).IsEqualTo(status);
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var db = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await db.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    internal static async Task<(ReviewSubmissionEndpointTests.Seeded Data, AssetCandidate Asset)> PrepareAsync(
        HttpsApplicationFixture fixture, bool approve = true)
    {
        fixture.App.Configuration["Publication:Origin"] = "https://publications.example.test";
        var data = await ReviewSubmissionEndpointTests.SeedAsync(fixture, false);
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = "Synthetic room",
            Kind = "environment",
            Bytes = bytes,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            Status = "approved",
            ValidationJson = "{}",
            Source = "Synthetic fixture",
            License = "Synthetic test only",
            ReviewNotes = "Fixture approval",
            SubmittedBy = data.Educator,
            ReviewedBy = data.Educator,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.AssetCandidates.Add(asset);
            var project = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
            var document = JsonNode.Parse(project.DocumentJson)!;
            document["scenes"]![0]!["environmentAssetId"] = asset.Id.ToString();
            document["scenes"]![0]!["objects"] = new JsonArray();
            project.DocumentJson = document.ToJsonString();
            await database.SaveChangesAsync();
        }
        var submission = Guid.NewGuid();
        using var submitted = await ReviewSubmissionEndpointTests.SubmitAsync(fixture, data.ProjectId, submission, 0, true);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await fixture.SignInAsync(data.Educator);
        if (approve)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{data.ProjectId}/submissions/{submission}/decisions")
            {
                Content = JsonContent.Create(new { decisionId = Guid.NewGuid(), expectedRevision = 0, outcome = "approved", feedback = "Approved" }),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var approved = await fixture.Client.SendAsync(request);
            await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
        return (data, asset);
    }

    private static async Task<HttpResponseMessage> PublishAsync(HttpsApplicationFixture fixture, Guid project, Guid id,
        string audience = "Authenticated", Guid[]? viewers = null, long revision = 0)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/projects/{project}/publications")
        {
            Content = JsonContent.Create(new { publicationId = id, confirmedRevision = revision, intent = new { audience, viewerIds = viewers ?? [] } }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }
}
