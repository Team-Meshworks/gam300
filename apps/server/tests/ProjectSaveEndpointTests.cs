using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectSaveEndpointTests
{
    private const string BodyMarker = "private-put-document-not-for-errors-or-logs";

    [Test]
    public async Task ProjectPut_RepeatedRoomsSaveAndReopenThroughTheDevelopmentCatalogue()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var document = JsonNode.Parse(ProjectTestDocuments.Create(project.Id, BodyMarker, 2))!;
        var objects = document["scenes"]![0]!["objects"]!.AsArray();

        // Use the editor's real model identity for two independent instances of the same room
        var room = objects[0]!.DeepClone();
        room["id"] = Guid.NewGuid().ToString();
        room["assetId"] = "test-room-module-v1";
        room["parentId"] = null;
        room["components"] = new JsonArray();
        objects.Add(room);
        var second = room.DeepClone();
        second["id"] = Guid.NewGuid().ToString();
        objects.Add(second);
        using var saved = await PutAsync(fixture, project.Id, Envelope(document.ToJsonString(), Guid.NewGuid()));
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);

        // Read through the authenticated endpoint and validate the persisted document again
        using var reopened = await fixture.Client.GetAsync(Path(project.Id));
        await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var response = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        await using var documentScope = fixture.App.Services.CreateAsyncScope();
        var documents = documentScope.ServiceProvider.GetRequiredService<ProjectDocumentService>();
        var accepted = documents.Read(project.Id, response.GetProperty("document").GetRawText());
        await Assert.That(accepted.Ok).IsTrue();
        var content = (Spatia.ProjectFormat.ContentProject)accepted.Value!;
        await Assert.That(content.Scenes[0].Objects.Count(item => item.AssetId == "test-room-module-v1")).IsEqualTo(2);
    }

    [Test]
    public async Task ProjectPut_ApprovedStarterRoomInstancesSaveAndReopenInProduction()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Production");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var bytes = await File.ReadAllBytesAsync(System.IO.Path.GetFullPath(
            "../../../../../../assets/delivery/test-room.glb", AppContext.BaseDirectory));
        var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        using var manifest = JsonDocument.Parse(typeof(ProjectDocumentService).Assembly.GetManifestResourceStream("Spatia.Assets.Manifest")!);
        foreach (var id in new[] { "test-room-v1", "test-room-module-v1" })
        {
            var entry = manifest.RootElement.GetProperty("assets").EnumerateArray()
                .Single(asset => asset.GetProperty("assetId").GetString() == id);
            await Assert.That(entry.GetProperty("sha256").GetString()).IsEqualTo(hash);
        }

        async Task<AssetAdministrationRecord> ApproveAsync(string kind)
        {
            var category = kind == "model" ? "&category=Architecture" : "";
            using var upload = new HttpRequestMessage(HttpMethod.Post, $"/api/admin/assets?name=starter-{kind}.glb&kind={kind}{category}");
            upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            upload.Content = new ByteArrayContent(bytes);
            upload.Content.Headers.ContentType = new("model/gltf-binary");
            using var submitted = await fixture.Client.SendAsync(upload);
            await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
            var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
            await Assert.That(candidate.Status).IsEqualTo("pending");
            await Assert.That(candidate.Sha256).IsEqualTo(hash);
            using var reviewed = await AuthTestRequests.PostAsync(fixture, $"/api/admin/assets/{candidate.Id}/approve",
                new AssetReviewRequest("Synthetic test fixture", "Synthetic test fixture", "Approved for test"));
            await Assert.That(reviewed.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var approved = (await reviewed.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
            await Assert.That(approved.Status).IsEqualTo("approved");
            await Assert.That(approved.Hidden).IsFalse();
            return approved;
        }

        var environment = await ApproveAsync("environment");
        var model = await ApproveAsync("model");
        await Assert.That(environment.Id).IsNotEqualTo(model.Id);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var catalogue = await fixture.Client.GetAsync("/api/assets");
        await Assert.That(catalogue.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var entries = await catalogue.Content.ReadFromJsonAsync<JsonElement>();
        foreach (var asset in new[] { environment, model })
        {
            var row = entries.EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == asset.Id);
            await Assert.That(row.GetProperty("kind").GetString()).IsEqualTo(asset.Kind);
            await Assert.That(row.GetProperty("sha256").GetString()).IsEqualTo(hash);
        }

        using var created = await AuthTestRequests.PostAsync(fixture, "/api/projects/",
            new { title = "Production Starter rooms", environmentAssetId = environment.Id.ToString() });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projectId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        var json = ProjectTestDocuments.Create(projectId, "Production Starter rooms", 2)
            .Replace("test-room-v1", environment.Id.ToString(), StringComparison.Ordinal)
            .Replace("test-crate-v1", model.Id.ToString(), StringComparison.Ordinal);
        var document = JsonNode.Parse(json)!;
        var objects = document["scenes"]![0]!["objects"]!.AsArray();
        var room = objects[0]!.DeepClone();
        var firstId = Guid.NewGuid();
        room["id"] = firstId.ToString();
        room["parentId"] = null;
        room["components"] = new JsonArray();
        objects.Add(room);
        var second = room.DeepClone();
        var secondId = Guid.NewGuid();
        second["id"] = secondId.ToString();
        objects.Add(second);
        using var saved = await PutAsync(fixture, projectId, Envelope(document.ToJsonString(), Guid.NewGuid()));
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await saved.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("revision").GetInt64()).IsEqualTo(1L);

        using var reopened = await fixture.Client.GetAsync(Path(projectId));
        await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var response = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(response.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        var scene = response.GetProperty("document").GetProperty("scenes")[0];
        await Assert.That(scene.GetProperty("environmentAssetId").GetGuid()).IsEqualTo(environment.Id);
        foreach (var instanceId in new[] { firstId, secondId })
        {
            var instance = scene.GetProperty("objects").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == instanceId);
            await Assert.That(instance.GetProperty("assetId").GetGuid()).IsEqualTo(model.Id);
        }
    }

    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task ProjectPut_HistoricalRetryReturnsOriginalAcknowledgementWithoutChangingNewerDraft(int version)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var document = ProjectTestDocuments.Create(project.Id, BodyMarker, version);
        var body = Envelope(document, Guid.NewGuid());
        using var first = await PutAsync(fixture, project.Id, body);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var acknowledgement = await first.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(acknowledgement.EnumerateObject().Select(field => field.Name).Order()
            .SequenceEqual(new[] { "clientMutationId", "projectId", "revision", "savedAt" })).IsTrue();
        await Assert.That(acknowledgement.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        await Assert.That(acknowledgement.GetProperty("projectId").GetGuid()).IsEqualTo(project.Id);
        using var retry = await PutAsync(fixture, project.Id, body);
        await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(JsonElement.DeepEquals(await retry.Content.ReadFromJsonAsync<JsonElement>(), acknowledgement)).IsTrue();
        var stored = await ReadAsync(fixture);
        using var reopened = await fixture.Client.GetAsync(Path(project.Id));
        await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var opened = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        await using var documentScope = fixture.App.Services.CreateAsyncScope();
        var documents = documentScope.ServiceProvider.GetRequiredService<ProjectDocumentService>();
        using var expected = JsonDocument.Parse(documents.Serialize(documents.Read(project.Id, document).Value!).Value!);
        await Assert.That(JsonElement.DeepEquals(opened.GetProperty("document"), expected.RootElement)).IsTrue();
        await Assert.That(opened.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        await Assert.That(acknowledgement.GetProperty("savedAt").GetDateTimeOffset()).IsEqualTo(stored.UpdatedAt);
        using var changed = await PutAsync(fixture, project.Id, body.Replace(BodyMarker, "Changed", StringComparison.Ordinal));
        await AssertProblemAsync(fixture, changed, HttpStatusCode.Conflict, "revision_conflict", 1);
        using var stale = await PutAsync(fixture, project.Id, Envelope(document, Guid.NewGuid()));
        await AssertProblemAsync(fixture, stale, HttpStatusCode.Conflict, "revision_conflict", 1);
        await AssertUnchangedAsync(await ReadAsync(fixture), stored);

        using var second = await PutAsync(fixture, project.Id,
            Envelope(ProjectTestDocuments.Create(project.Id, "Newer draft", version), Guid.NewGuid(), 1));
        await Assert.That(second.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var newer = await ReadAsync(fixture);
        await Assert.That(newer.Revision).IsEqualTo(2L);
        using var historical = await PutAsync(fixture, project.Id, body);
        await Assert.That(historical.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(JsonElement.DeepEquals(await historical.Content.ReadFromJsonAsync<JsonElement>(), acknowledgement)).IsTrue();
        await AssertUnchangedAsync(await ReadAsync(fixture), newer);
    }

    [Test]
    [Arguments("content")]
    [Arguments("whitespace")]
    [Arguments("number-spelling")]
    [Arguments("revision")]
    [Arguments("actor")]
    public async Task ProjectPut_HistoricalMutationIdCannotBeReusedAtTheCurrentRevision(string change)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var mutation = Guid.NewGuid();
        var document = ProjectTestDocuments.Create(project.Id, BodyMarker);
        using var first = await PutAsync(fixture, project.Id, Envelope(document, mutation));
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var second = await PutAsync(fixture, project.Id,
            Envelope(ProjectTestDocuments.Create(project.Id, "Newer draft"), Guid.NewGuid(), 1));
        await Assert.That(second.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var newer = await ReadAsync(fixture);
        if (change == "actor")
        {
            var actor = await fixture.CreateAccountAsync();
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE organization_memberships SET organization_id = {project.OrganizationId} WHERE user_id = {actor}");
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = project.Id, UserId = actor, CanEdit = true });
            await database.SaveChangesAsync();
            await fixture.SignInAsync(actor);
        }
        document = change switch
        {
            "content" => document.Replace(BodyMarker, "Changed", StringComparison.Ordinal),
            "whitespace" => "{ \n" + document[1..],
            "number-spelling" => document.Replace("\"schemaVersion\":1", "\"schemaVersion\":1.0", StringComparison.Ordinal),
            _ => document
        };
        foreach (var revision in change == "revision" ? new[] { 2L } : new[] { 0L, 2L })
        {
            using var reused = await PutAsync(fixture, project.Id, Envelope(document, mutation, revision));
            await AssertProblemAsync(fixture, reused, HttpStatusCode.Conflict, "revision_conflict", 2);
            await AssertUnchangedAsync(await ReadAsync(fixture), newer);
        }
    }

    [Test]
    [Arguments("catalogue")]
    [Arguments("revision-limit")]
    public async Task ProjectPut_HistoricalRetrySurvivesCatalogueChangeOrRevisionExhaustion(string change)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var document = ProjectTestDocuments.Create(project.Id, BodyMarker);
        var original = Envelope(document, Guid.NewGuid());
        using var first = await PutAsync(fixture, project.Id, original);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var second = await PutAsync(fixture, project.Id, Envelope(document, Guid.NewGuid(), 1));
        await Assert.That(second.StatusCode).IsEqualTo(HttpStatusCode.OK);
        if (change == "revision-limit")
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE projects SET revision = {Project.MaxRevision} WHERE id = {project.Id}");
        }
        var before = await ReadAsync(fixture);
        await using var otherHost = await fixture.CreateSiblingAsync(builder =>
        {
            if (change == "catalogue")
            {
                builder.Environment.EnvironmentName = "Testing";
                builder.Services.AddSingleton<Microsoft.Extensions.Hosting.IHostEnvironment>(builder.Environment);
            }
        });
        await otherHost.SignInAsync(before.LastMutationActorId!.Value);
        using var unknown = await PutAsync(otherHost, project.Id, Envelope(document, Guid.NewGuid(), before.Revision));
        await AssertProblemAsync(otherHost, unknown,
            change == "catalogue" ? HttpStatusCode.UnprocessableEntity : HttpStatusCode.Conflict,
            change == "catalogue" ? "invalid_document" : "revision_exhausted", change == "catalogue" ? null : before.Revision);
        using var retry = await PutAsync(otherHost, project.Id, original);
        await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await retry.Content.ReadAsStringAsync()).IsEqualTo(await first.Content.ReadAsStringAsync());
        await AssertUnchangedAsync(await ReadAsync(fixture), before);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ProjectPut_ReceiptFailureRollsBackDraftAndPreservesPreviousReceipts(bool beforeCommit)
    {
        var commitFailure = new CommitFailure();
        var insertFailure = new ReceiptInsertFailure();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commitFailure, insertFailure)),
            environmentName: "Development");
        var project = await SeedAsync(fixture);
        var original = Envelope(ProjectTestDocuments.Create(project.Id, "First saved draft"), Guid.NewGuid());
        using var first = await PutAsync(fixture, project.Id, original);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var before = await ReadAsync(fixture);
        commitFailure.Armed = beforeCommit;
        insertFailure.Armed = !beforeCommit;
        var attempted = Envelope(ProjectTestDocuments.Create(project.Id, BodyMarker), Guid.NewGuid(), 1);
        using var failure = await PutAsync(fixture, project.Id, attempted);
        await AssertProblemAsync(fixture, failure, HttpStatusCode.ServiceUnavailable, "storage_unavailable");
        await AssertUnchangedAsync(await ReadAsync(fixture), before);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Database.SqlQuery<long>($"SELECT count(*) AS \"Value\" FROM project_save_receipts").SingleAsync()).IsEqualTo(1L);
        using var retried = await PutAsync(fixture, project.Id, attempted);
        await Assert.That(retried.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await ReadAsync(fixture)).Revision).IsEqualTo(2L);
        using var historical = await PutAsync(fixture, project.Id, original);
        await Assert.That(historical.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await historical.Content.ReadAsStringAsync()).IsEqualTo(await first.Content.ReadAsStringAsync());
        await Assert.That(await database.Database.SqlQuery<long>($"SELECT count(*) AS \"Value\" FROM project_save_receipts").SingleAsync()).IsEqualTo(2L);
    }

    [Test]
    public async Task ProjectPut_InvalidEnvelopeAndDocumentsPreserveTheLatestSavedDraftAndRetry()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var document = ProjectTestDocuments.Create(project.Id, BodyMarker);
        var body = Envelope(document, Guid.NewGuid());
        using var original = await PutAsync(fixture, project.Id, body);
        await Assert.That(original.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var newer = await PutAsync(fixture, project.Id,
            Envelope(ProjectTestDocuments.Create(project.Id, "Newer draft"), Guid.NewGuid(), 1));
        await Assert.That(newer.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var stored = await ReadAsync(fixture);
        foreach (var (invalid, status, code) in new[]
        {
            ("{", HttpStatusCode.BadRequest, "invalid_json"),
            ("{\"ownerId\":\"" + BodyMarker + "\"," + body[1..], HttpStatusCode.BadRequest, "invalid_envelope"),
            (body.Replace("\"expectedRevision\":0", "\"expectedRevision\":-1", StringComparison.Ordinal), HttpStatusCode.BadRequest, "invalid_expected_revision"),
            (Envelope(ProjectTestDocuments.Create(Guid.NewGuid(), BodyMarker), Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "project_id_mismatch"),
            (Envelope("{\"permissions\":{\"canEdit\":true}," + document[1..], Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "invalid_document"),
            (Envelope(document.Replace("test-crate-v1", "unapproved-asset", StringComparison.Ordinal), Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "invalid_document"),
            (Envelope(ProjectTestDocuments.Create(project.Id, "before\0after"), Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "invalid_document"),
        })
        {
            using var response = await PutAsync(fixture, project.Id, invalid);
            await AssertProblemAsync(fixture, response, status, code);
            await AssertUnchangedAsync(await ReadAsync(fixture), stored);
        }
        using var replay = await PutAsync(fixture, project.Id, body);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await replay.Content.ReadAsStringAsync()).IsEqualTo(await original.Content.ReadAsStringAsync());
        await AssertUnchangedAsync(await ReadAsync(fixture), stored);
    }

    [Test]
    [Arguments("unassigned", HttpStatusCode.NotFound, "project_not_found")]
    [Arguments("other-organization", HttpStatusCode.NotFound, "project_not_found")]
    [Arguments("archived", HttpStatusCode.Forbidden, "project_read_only")]
    public async Task ProjectPut_DeniedMatchingRetryDoesNotDiscloseOrAlterSavedState(string state, HttpStatusCode status, string code)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var body = Envelope(ProjectTestDocuments.Create(project.Id, BodyMarker), Guid.NewGuid());
        using var original = await PutAsync(fixture, project.Id, body);
        await Assert.That(original.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var newer = await PutAsync(fixture, project.Id,
            Envelope(ProjectTestDocuments.Create(project.Id, "Newer draft"), Guid.NewGuid(), 1));
        await Assert.That(newer.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var stored = await ReadAsync(fixture);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (state == "unassigned")
            {
                await database.ProjectAssignments.ExecuteDeleteAsync();
            }
            else
            {
                var row = await database.Projects.SingleAsync();
                if (state == "archived")
                {
                    row.IsArchived = true;
                }
                else
                {
                    var other = new Organization { Id = Guid.NewGuid(), Name = "Other organization" };
                    database.Organizations.Add(other);
                    row.OrganizationId = other.Id;
                }
                await database.SaveChangesAsync();
            }
        }
        using var denied = await PutAsync(fixture, project.Id, body);
        await AssertProblemAsync(fixture, denied, status, code);
        await AssertUnchangedAsync(await ReadAsync(fixture), stored);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ProjectPut_ConcurrentRequestsFromOneRevisionCommitOnlyOneDraftAndReceipt(bool identical)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var csrf = await fixture.GetCsrfAsync();
        var bodies = new[] { "First", "Second" }.Select(title => Envelope(ProjectTestDocuments.Create(project.Id, title), Guid.NewGuid())).ToArray();
        if (identical) { bodies[1] = bodies[0]; }
        var responses = await Task.WhenAll(bodies.Select(body => PutAsync(fixture, project.Id, body, csrf)));
        try
        {
            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.OK)).IsEqualTo(identical ? 2 : 1);
            if (identical)
            {
                await Assert.That(await responses[0].Content.ReadAsStringAsync()).IsEqualTo(await responses[1].Content.ReadAsStringAsync());
            }
            else
            {
                var loser = responses.Single(response => response.StatusCode != HttpStatusCode.OK);
                await AssertProblemAsync(fixture, loser, HttpStatusCode.Conflict, "revision_conflict", 1);
            }
            var stored = await ReadAsync(fixture);
            await Assert.That(stored.Revision).IsEqualTo(1L);
            using var winner = JsonDocument.Parse(bodies[Array.FindIndex(responses, response => response.StatusCode == HttpStatusCode.OK)]);
            await Assert.That(stored.LastMutationId).IsEqualTo((Guid?)winner.RootElement.GetProperty("clientMutationId").GetGuid());
            using var actual = JsonDocument.Parse(stored.DocumentJson);
            await Assert.That(actual.RootElement.GetProperty("title").GetString())
                .IsEqualTo(winner.RootElement.GetProperty("document").GetProperty("title").GetString());
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var receipt = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectSaveReceipts.SingleAsync();
            await Assert.That(receipt.ClientMutationId).IsEqualTo(stored.LastMutationId!.Value);
            await Assert.That(receipt.Revision).IsEqualTo(1L);
        }
        finally
        {
            foreach (var response in responses) { response.Dispose(); }
        }
    }

    [Test]
    public async Task ProjectPut_CommitFailureReturnsSafeStorageProblemAndRollsBack()
    {
        var failure = new CommitFailure();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)),
            environmentName: "Development");
        var project = await SeedAsync(fixture);
        var before = await ReadAsync(fixture);
        var csrf = await fixture.GetCsrfAsync();
        failure.Armed = true;
        using var response = await PutAsync(fixture, project.Id, Envelope(ProjectTestDocuments.Create(project.Id, BodyMarker), Guid.NewGuid()), csrf);
        await AssertProblemAsync(fixture, response, HttpStatusCode.ServiceUnavailable, "storage_unavailable");
        await AssertUnchangedAsync(await ReadAsync(fixture), before);
    }

    private static string Path(Guid id) => "/api/projects/" + id.ToString("D");
    private static string Envelope(string document, Guid mutation, long revision = 0) =>
        $$"""{"expectedRevision":{{revision}},"clientMutationId":"{{mutation:D}}","document":{{document}}}""";

    private static async Task<Project> SeedAsync(HttpsApplicationFixture fixture)
    {
        var actor = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var id = Guid.NewGuid();
        var project = new Project
        {
            Id = id,
            OrganizationId = await database.Organizations.Select(row => row.Id).SingleAsync(),
            SchemaVersion = 1,
            DocumentJson = ProjectTestDocuments.Create(id, "Original"),
            UpdatedAt = DateTimeOffset.UnixEpoch
        };
        database.Projects.Add(project);
        database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = actor, CanEdit = true });
        await database.SaveChangesAsync();
        await fixture.SignInAsync(actor);
        return project;
    }

    private static async Task<HttpResponseMessage> PutAsync(HttpsApplicationFixture fixture, Guid id, string body, string? csrf = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, Path(id)) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-CSRF-TOKEN", csrf ?? await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }

    private static async Task<Project> ReadAsync(HttpsApplicationFixture fixture)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.AsNoTracking().SingleAsync();
    }

    private static async Task AssertUnchangedAsync(Project actual, Project expected)
    {
        await Assert.That(actual.DocumentJson).IsEqualTo(expected.DocumentJson);
        await Assert.That(actual.SchemaVersion).IsEqualTo(expected.SchemaVersion);
        await Assert.That(actual.Revision).IsEqualTo(expected.Revision);
        await Assert.That(actual.UpdatedAt).IsEqualTo(expected.UpdatedAt);
        await Assert.That(actual.LastMutationId).IsEqualTo(expected.LastMutationId);
        await Assert.That(actual.LastMutationActorId).IsEqualTo(expected.LastMutationActorId);
        await Assert.That(actual.LastMutationDigest is null ? expected.LastMutationDigest is null
            : expected.LastMutationDigest is not null && actual.LastMutationDigest.SequenceEqual(expected.LastMutationDigest)).IsTrue();
    }

    private static async Task AssertProblemAsync(HttpsApplicationFixture fixture, HttpResponseMessage response,
        HttpStatusCode status, string code, long? revision = null)
    {
        await AuthTestRequests.AssertProblemAsync(response, status, code);
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        var fields = new[] { "type", "title", "status", "code", "traceId" }.Concat(revision is null ? [] : new[] { "currentRevision" });
        await Assert.That(problem.EnumerateObject().Select(field => field.Name).Order().SequenceEqual(fields.Order())).IsTrue();
        if (revision is not null) { await Assert.That(problem.GetProperty("currentRevision").GetInt64()).IsEqualTo(revision.Value); }
        await Assert.That(problem.GetRawText().Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    private sealed class CommitFailure : DbTransactionInterceptor
    {
        public bool Armed { get; set; }
        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed) { Armed = false; throw new NpgsqlException(BodyMarker); }
            return ValueTask.FromResult(result);
        }
    }

    private sealed class ReceiptInsertFailure : DbCommandInterceptor
    {
        public bool Armed { get; set; }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.StartsWith("INSERT INTO project_save_receipts", StringComparison.Ordinal))
            {
                Armed = false;
                throw new NpgsqlException(BodyMarker);
            }
            return ValueTask.FromResult(result);
        }
    }
}
