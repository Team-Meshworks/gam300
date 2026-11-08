using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AssetIntakeTests))]
public sealed class AssetIntakeTests
{
    [Test]
    public async Task IntakeAudio_ValidatesRealAudioAndRejectsInvalidContent()
    {
        var audio = await File.ReadAllBytesAsync(System.IO.Path.GetFullPath(
            "../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));
        // Validate every supplied track so intake accepts the same BGM files the library offers
        var directory = Path.GetFullPath("../../../../../../assets/delivery/audio", AppContext.BaseDirectory);
        foreach (var track in Directory.EnumerateFiles(directory, "*.m4a"))
        {
            await Assert.That(AssetAudioValidator.Validate(await File.ReadAllBytesAsync(track)).Valid)
                .IsTrue().Because(Path.GetFileName(track));
        }
        await Assert.That(AssetAudioValidator.Validate(audio[..^20]).Valid).IsFalse();
        await Assert.That(AssetAudioValidator.Validate(CreateMinimalGlb()).Valid).IsFalse();
        await Assert.That(AssetIntakePolicy.Accepts("track.m4a", "audio", "BGM")).IsTrue();
        await Assert.That(AssetIntakePolicy.Accepts("track.glb", "audio", "BGM")).IsFalse();
        await Assert.That(AssetIntakePolicy.Accepts("track.m4a", "audio", "Unknown")).IsFalse();
    }

    [Test]
    public async Task IntakeAudio_PreservesAuthorizedProjectReferences()
    {
        var audio = await File.ReadAllBytesAsync(System.IO.Path.GetFullPath(
            "../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));

        // Exercise the production catalogue and the existing administrator-only upload route
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Production");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var creator = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(admin);
        async Task<AssetAdministrationRecord> UploadAsync(string name, string kind, string? category, byte[] bytes)
        {
            var query = $"/api/v1/admin/assets?name={name}&kind={kind}" + (category is null ? "" : $"&category={category}");
            using var upload = new HttpRequestMessage(HttpMethod.Post, query);
            upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            upload.Content = new ByteArrayContent(bytes);
            upload.Content.Headers.ContentType = new(kind == "audio" ? "audio/mp4" : "model/gltf-binary");
            using var response = await fixture.Client.SendAsync(upload);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
            return (await response.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        }
        var invalid = await UploadAsync("invalid.m4a", "audio", "BGM", audio[..^20]);
        await Assert.That(invalid.Status).IsEqualTo("invalid");
        var environment = await UploadAsync("room.glb", "environment", null, CreateMinimalGlb());
        var model = await UploadAsync("object.glb", "model", "Objects", CreateMinimalGlb());
        var track = await UploadAsync("track.m4a", "audio", "BGM", audio);
        await Assert.That(track.Status).IsEqualTo("approved");
        using var inspection = await fixture.Client.GetAsync($"/api/v1/admin/assets/{track.Id}/bytes");
        await Assert.That(inspection.Content.Headers.ContentType!.MediaType).IsEqualTo("audio/mp4");
        await Assert.That(inspection.Content.Headers.ContentDisposition!.FileName!.Trim('"')).IsEqualTo($"asset-{track.Id}.m4a");

        await fixture.SignInAsync(creator);
        using var catalogue = await fixture.Client.GetAsync("/api/v1/assets");
        var entries = await catalogue.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(entries.EnumerateArray().Any(item => item.GetProperty("id").GetGuid() == track.Id)).IsTrue();
        await Assert.That(entries.EnumerateArray().Any(item => item.GetProperty("id").GetGuid() == invalid.Id)).IsFalse();
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Audio project", environmentAssetId = environment.Id.ToString() });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projectId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        var json = ProjectTestDocuments.Create(projectId, "Audio project", 2)
            .Replace("test-room-v1", environment.Id.ToString(), StringComparison.Ordinal)
            .Replace("test-crate-v1", model.Id.ToString(), StringComparison.Ordinal);
        var document = JsonNode.Parse(json)!;
        document["scenes"]![0]!["objects"]![0]!["components"]!.AsArray().Add(new JsonObject
        {
            ["id"] = Guid.NewGuid().ToString(),
            ["type"] = "audio",
            ["assetId"] = track.Id.ToString(),
            ["caption"] = "Music",
            ["loop"] = true,
            ["volume"] = 0.75,
            ["mode"] = "spatial"
        });
        async Task<HttpResponseMessage> SaveAsync(long revision)
        {
            using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/projects/{projectId}");
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            request.Content = JsonContent.Create(new { expectedRevision = revision, clientMutationId = Guid.NewGuid(), document });
            return await fixture.Client.SendAsync(request);
        }
        using var saved = await SaveAsync(0);
        if (!saved.IsSuccessStatusCode) { throw new InvalidOperationException(await saved.Content.ReadAsStringAsync()); }
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var reopened = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}");
        var reopenedDocument = (await reopened.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document");
        var components = reopenedDocument.GetProperty("scenes")[0].GetProperty("objects")[0].GetProperty("components");
        await Assert.That(components.EnumerateArray().Any(item => item.GetProperty("type").GetString() == "audio"
            && item.GetProperty("assetId").GetGuid() == track.Id)).IsTrue();

        // Hiding or deleting prevents new selection while keeping the exact saved project bytes
        await fixture.SignInAsync(admin);
        using var deleted = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{track.Id}/availability",
            new AssetAvailabilityRequest("delete"));
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await fixture.SignInAsync(creator);
        using var unavailable = await fixture.Client.GetAsync($"/api/v1/assets/{track.Id}/bytes");
        await Assert.That(unavailable.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var retained = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets/{track.Id}/bytes");
        await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(retained.Content.Headers.ContentType!.MediaType).IsEqualTo("audio/mp4");
        await Assert.That((await retained.Content.ReadAsByteArrayAsync()).SequenceEqual(audio)).IsTrue();
        using var savedAgain = await SaveAsync(1);
        await Assert.That(savedAgain.StatusCode).IsEqualTo(HttpStatusCode.OK);

        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var denied = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets/{track.Id}/bytes");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task Intake_RejectsInvalidProvenanceBeforeStoringAsset()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        foreach (var encoded in new[] { "not-base64", Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { source = new string('x', 2001) })) })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=room.glb&kind=environment");
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            request.Headers.Add("X-Spatia-Asset-Metadata", encoded);
            request.Content = new ByteArrayContent(CreateMinimalGlb());
            request.Content.Headers.ContentType = new("model/gltf-binary");
            using var response = await fixture.Client.SendAsync(request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().AssetCandidates.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Intake_ImmediateAvailabilityRetainsSuppliedProvenance()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=room.glb&kind=environment");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        var metadata = JsonSerializer.SerializeToUtf8Bytes(new { source = "Museum archive", license = "CC BY 4.0", reviewNotes = "Rights checked" });
        request.Headers.Add("X-Spatia-Asset-Metadata", Convert.ToBase64String(metadata));
        request.Content = new ByteArrayContent(CreateMinimalGlb());
        request.Content.Headers.ContentType = new("model/gltf-binary");
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var asset = (await response.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(asset.Status).IsEqualTo("approved");
        await Assert.That(asset.Source).IsEqualTo("Museum archive");
        await Assert.That(asset.License).IsEqualTo("CC BY 4.0");
        await Assert.That(asset.ReviewNotes).IsEqualTo("Rights checked");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var stored = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().AssetCandidates.AsNoTracking().SingleAsync(row => row.Id == asset.Id);
        await Assert.That(stored.Source).IsEqualTo("Museum archive");
        await Assert.That(stored.License).IsEqualTo("CC BY 4.0");
        await Assert.That(stored.ReviewNotes).IsEqualTo("Rights checked");
    }

    [Test]
    [Arguments("environment", "room.glb", null)]
    [Arguments("model", "object.glb", "Objects")]
    public async Task Intake_ValidAdminUploadIsImmediatelyAvailable(string kind, string name, string? category)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var query = $"/api/v1/admin/assets?name={name}&kind={kind}" + (category is null ? "" : $"&category={category}");
        using var upload = new HttpRequestMessage(HttpMethod.Post, query);
        upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        upload.Content = new ByteArrayContent(CreateMinimalGlb());
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var response = await fixture.Client.SendAsync(upload);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var asset = (await response.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(asset.Status).IsEqualTo("approved");
        await Assert.That(asset.Hidden).IsFalse();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        using var catalogue = await fixture.Client.GetAsync("/api/v1/assets");
        var entries = await catalogue.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(entries.EnumerateArray().Any(entry => entry.GetProperty("id").GetString() == asset.Id.ToString())).IsTrue();
        using var bytes = await fixture.Client.GetAsync($"/api/v1/assets/{asset.Id}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
    }

    [Test]
    public async Task IntakePolicy_RejectsPathsRemoteUrlsUnknownKindsAndSpaceCategories()
    {
        foreach (var name in new[] { "../room.glb", "folder/room.glb", "folder\\room.glb", "https://remote/room.glb", "room.gltf", "bad\n.glb", ".glb" })
        {
            await Assert.That(AssetIntakePolicy.Accepts(name, "environment", null)).IsFalse();
        }
        await Assert.That(AssetIntakePolicy.Accepts("Room.GLB", "environment", null)).IsTrue();
        await Assert.That(AssetIntakePolicy.Accepts("room.glb", "environment", "Architecture")).IsFalse();
        await Assert.That(AssetIntakePolicy.Accepts("crate.glb", "model", "Objects")).IsTrue();
        await Assert.That(AssetIntakePolicy.Accepts("crate.glb", "model", "Unknown")).IsFalse();
        // Keep malformed content distinct from unavailable tooling and valid files with reviewable warnings
        var validator = new AssetUploadValidator(new ConfigurationBuilder().Build());
        var valid = await validator.ValidateAsync(CreateMinimalGlb(), default);
        await Assert.That(valid.HasValue).IsTrue();
        await Assert.That(valid!.Value.Valid).IsTrue();
        var invalid = await validator.ValidateAsync(new byte[20], default);
        await Assert.That(invalid.HasValue).IsTrue();
        await Assert.That(invalid!.Value.Valid).IsFalse();
        await Assert.That(invalid!.Value.Messages.Length > 0).IsTrue();
        var missing = new AssetUploadValidator(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AssetIntake:ValidatorScript"] = Path.Combine(AppContext.BaseDirectory, Guid.NewGuid() + ".mjs"),
        }).Build());
        await Assert.That(await missing.ValidateAsync(CreateMinimalGlb(), default) is null).IsTrue();

    }

    [Test]
    public async Task Intake_WarningSaturationCannotProduceAnApprovableCandidate()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var token = await fixture.GetCsrfAsync();

        // Saturate the validator with warnings before its unresolved scene reference can be reported
        var document = JsonSerializer.Serialize(new
        {
            asset = new { version = "2.0" },
            nodes = Enumerable.Range(0, 110).Select(_ => new { unexpectedProperty = true }).ToArray(),
            scenes = new[] { new { nodes = new[] { 999 } } },
            scene = 0
        });
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=invalid.glb&kind=model&category=Objects");
        upload.Headers.Add("X-CSRF-TOKEN", token);
        upload.Content = new ByteArrayContent(CreateMinimalGlb(document));
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(candidate.Status).IsEqualTo("invalid");

        // Retain private diagnostics for inspection while preventing review from approving incomplete validation
        using var review = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/admin/assets/{candidate.Id}/approve");
        review.Headers.Add("X-CSRF-TOKEN", token);
        review.Content = JsonContent.Create(new AssetReviewRequest("Synthetic source", "Synthetic rights", "Synthetic review"));
        using var rejected = await fixture.Client.SendAsync(review);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        using var bytes = await fixture.Client.GetAsync($"/api/v1/assets/{candidate.Id}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    [Arguments("{}")]
    [Arguments("{\"source\":\"\",\"license\":\"\",\"reviewNotes\":\"\"}")]
    [Arguments("{\"source\":null,\"license\":null,\"reviewNotes\":null}")]
    [Arguments("{\"source\":\"Synthetic source\"}")]
    [Arguments("{\"license\":\"Synthetic rights\"}")]
    [Arguments("{\"reviewNotes\":\"Reviewed room\"}")]
    public async Task Intake_OptionalApprovalDetailsPersistAndMakeRoomAvailableToTeachers(string reviewJson)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=room.glb&kind=environment");
        upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        upload.Content = new ByteArrayContent(CreateMinimalGlb());
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(candidate.Status).IsEqualTo("approved");
        candidate = candidate with { Id = await SeedLegacyPendingAsync(fixture, candidate.Id) };

        using var details = JsonDocument.Parse(reviewJson);
        using var approved = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{candidate.Id}/approve", details.RootElement);
        await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var record = (await approved.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        var expected = JsonSerializer.Deserialize<AssetReviewRequest>(reviewJson, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        await Assert.That(record.Status).IsEqualTo("approved");
        await Assert.That(record.Hidden).IsFalse();
        await Assert.That(record.Source).IsEqualTo(expected.Source ?? "");
        await Assert.That(record.License).IsEqualTo(expected.License ?? "");
        await Assert.That(record.ReviewNotes).IsEqualTo(expected.ReviewNotes ?? "");
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var stored = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().AssetCandidates.AsNoTracking().SingleAsync(asset => asset.Id == candidate.Id);
            await Assert.That(stored.ReviewedBy).IsEqualTo((Guid?)admin);
            await Assert.That(stored.Source).IsEqualTo(record.Source);
            await Assert.That(stored.License).IsEqualTo(record.License);
            await Assert.That(stored.ReviewNotes).IsEqualTo(record.ReviewNotes);
        }

        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        using var catalogue = await fixture.Client.GetAsync("/api/v1/assets");
        await Assert.That(catalogue.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var entries = await catalogue.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(entries.EnumerateArray().Any(entry => entry.GetProperty("id").GetString() == candidate.Id.ToString())).IsTrue();
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Teacher project", environmentAssetId = candidate.Id.ToString() });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
    }

    [Test]
    public async Task Intake_PrivateCandidatePersistsAcrossScopesAndDeletionRetainsExactReviewedBytes()
    {
        // Follow one upload through private validation, explicit approval and retained project delivery
        var bytes = CreateMinimalGlb();
        // Exercise the validator packaged with the API, not a developer-only script override
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        var token = await fixture.GetCsrfAsync();
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=room.glb&kind=environment");
        upload.Headers.Add("X-CSRF-TOKEN", token);
        upload.Content = new ByteArrayContent(bytes);
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>();
        await Assert.That(candidate!.Status).IsEqualTo("approved");
        candidate = candidate with { Id = await SeedLegacyPendingAsync(fixture, candidate.Id) };
        using var inspection = await fixture.Client.GetAsync($"/api/v1/admin/assets/{candidate.Id}/bytes");
        await Assert.That(inspection.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(inspection.Content.Headers.ContentDisposition!.DispositionType).IsEqualTo("attachment");
        await Assert.That((await inspection.Content.ReadAsByteArrayAsync()).SequenceEqual(bytes)).IsTrue();
        // Legacy pending bytes never enter the student catalogue even for an unrestricted account
        using var pending = await fixture.Client.GetAsync($"/api/v1/assets/{candidate.Id}/bytes");
        await Assert.That(pending.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var review = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/admin/assets/{candidate.Id}/approve");
        review.Headers.Add("X-CSRF-TOKEN", token);
        // Escaped Unicode can exceed the default small-request budget while every field is still valid
        var reviewText = new string((char)0x754c, 2000);
        review.Content = JsonContent.Create(new AssetReviewRequest(reviewText, reviewText, reviewText));
        using var approved = await fixture.Client.SendAsync(review);
        await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var available = await fixture.Client.GetAsync($"/api/v1/assets/{candidate.Id}/bytes");
        await Assert.That((await available.Content.ReadAsByteArrayAsync()).SequenceEqual(bytes)).IsTrue();
        var projectId = Guid.NewGuid();
        var json = ProjectTestDocuments.Create(projectId, "Retained asset").Replace("test-room-v1", candidate.Id.ToString(), StringComparison.Ordinal);
        await using (var seed = fixture.Database.Services.CreateAsyncScope())
        {
            var seedDatabase = seed.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = new Organization { Id = Guid.NewGuid(), Name = "Synthetic asset project" };
            seedDatabase.Organizations.Add(organization);
            seedDatabase.Projects.Add(new Project
            {
                Id = projectId,
                OrganizationId = organization.Id,
                DocumentJson = json,
                SchemaVersion = 1,
                UpdatedAt = DateTimeOffset.UtcNow
            });
            await seedDatabase.SaveChangesAsync();
        }
        // Save through the real endpoint before retirement so the durable receipt can be replayed later
        async Task<HttpResponseMessage> SaveAsync(string document, long revision, Guid mutation)
        {
            using var parsed = JsonDocument.Parse(document);
            using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/projects/{projectId}");
            request.Headers.Add("X-CSRF-TOKEN", token);
            request.Content = JsonContent.Create(new { expectedRevision = revision, clientMutationId = mutation, document = parsed.RootElement });
            return await fixture.Client.SendAsync(request);
        }
        var originalMutation = Guid.NewGuid();
        using var originalSave = await SaveAsync(json, 0, originalMutation);
        await Assert.That(originalSave.StatusCode).IsEqualTo(HttpStatusCode.OK);
        // Ordinary deletion changes discovery while preserving the immutable row and audit metadata
        using var deletion = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/admin/assets/{candidate.Id}/availability");
        deletion.Headers.Add("X-CSRF-TOKEN", token);
        deletion.Content = JsonContent.Create(new AssetAvailabilityRequest("delete"));
        using var deleted = await fixture.Client.SendAsync(deletion);
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var hiddenBytes = await fixture.Client.GetAsync($"/api/v1/assets/{candidate.Id}/bytes");
        await Assert.That(hiddenBytes.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await database.AssetCandidates.AsNoTracking().SingleAsync(asset => asset.Id == candidate.Id);
        await Assert.That(stored.Deleted && stored.Hidden).IsTrue();
        await Assert.That(stored.Bytes.SequenceEqual(bytes)).IsTrue();
        await Assert.That(stored.ReviewedBy).IsEqualTo((Guid?)admin);
        await Assert.That(stored.Source).IsEqualTo(reviewText);
        // Stored documents keep their exact reference while new imports cannot select a retired version
        var documents = new ProjectDocumentService(fixture.App.Environment, database);
        await Assert.That(documents.ReadStored(projectId, 1, json).Ok).IsTrue();
        await Assert.That(documents.Read(projectId, json, json).Ok).IsTrue();
        await Assert.That(documents.Read(json).Ok).IsFalse();
        using var retained = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets/{candidate.Id}/bytes");
        await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await retained.Content.ReadAsByteArrayAsync()).SequenceEqual(bytes)).IsTrue();
        using var metadata = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets");
        await Assert.That(metadata.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(metadata.Headers.CacheControl?.NoStore).IsTrue();
        var entries = await metadata.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(entries.GetArrayLength()).IsEqualTo(1);
        await Assert.That(entries[0].GetProperty("id").GetString()).IsEqualTo(candidate.Id.ToString());
        await Assert.That(entries[0].GetProperty("url").GetString()).IsEqualTo($"/api/v1/projects/{projectId}/assets/{candidate.Id}/bytes");
        await Assert.That(entries[0].GetProperty("sha256").GetString()).IsEqualTo(stored.Sha256);
        using var missingMetadata = await fixture.Client.GetAsync($"/api/v1/projects/{Guid.NewGuid()}/assets");
        await Assert.That(missingMetadata.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var unrelated = await fixture.Client.GetAsync($"/api/v1/projects/{Guid.NewGuid()}/assets/{candidate.Id}/bytes");
        await Assert.That(unrelated.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        // Existing references remain saveable after retirement while an old retry acknowledges only its original commit
        using var retainedSave = await SaveAsync(json, 1, Guid.NewGuid());
        await Assert.That(retainedSave.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var withoutRetired = ProjectTestDocuments.Create(projectId, "Newer draft without retired asset");
        using var newerSave = await SaveAsync(withoutRetired, 2, Guid.NewGuid());
        await Assert.That(newerSave.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var noLongerReferenced = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets");
        await Assert.That((await noLongerReferenced.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(0);
        using var historicalRetry = await SaveAsync(json, 0, originalMutation);
        await Assert.That(historicalRetry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var replay = await historicalRetry.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(replay.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        using var reintroduced = await SaveAsync(json, 3, Guid.NewGuid());
        await Assert.That(reintroduced.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        var currentProject = await database.Projects.AsNoTracking().SingleAsync();
        await Assert.That(currentProject.Revision).IsEqualTo(3L);
        await Assert.That(AssetDocumentReferences.Read(currentProject.DocumentJson).Contains(candidate.Id.ToString())).IsFalse();
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
        // Final removal permanently denies retained bytes after ordinary retirement
        using var removal = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/admin/assets/{candidate.Id}/availability");
        removal.Headers.Add("X-CSRF-TOKEN", token);
        removal.Content = JsonContent.Create(new AssetAvailabilityRequest("remove", true));
        using var removed = await fixture.Client.SendAsync(removal);
        await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await database.AssetCandidates.AsNoTracking().SingleAsync(asset => asset.Id == candidate.Id)).RemovedFromProjects).IsTrue();
        // Database enforcement prevents later writers from replacing a reviewed version's bytes
        await Assert.ThrowsAsync<Npgsql.PostgresException>(async () => await database.Database.ExecuteSqlRawAsync("UPDATE asset_candidates SET bytes = decode('00', 'hex')"));
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var deniedMetadata = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets");
        await Assert.That(deniedMetadata.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task Intake_RequiresCurrentAdministratorAndCsrfAndRejectsMalformedMetadata()
    {
        // Reject anonymous and creator sessions before proving an administrator still needs a current CSRF token
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var anonymous = await fixture.Client.GetAsync("/api/v1/admin/assets");
        await Assert.That(anonymous.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var creator = await fixture.Client.GetAsync("/api/v1/admin/assets");
        await Assert.That(creator.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var deniedInspection = await fixture.Client.GetAsync($"/api/v1/admin/assets/{Guid.NewGuid()}/bytes");
        await Assert.That(deniedInspection.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        using var noCsrf = await fixture.Client.PostAsJsonAsync($"/api/v1/admin/assets/{Guid.NewGuid()}/availability", new AssetAvailabilityRequest("delete"));
        await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var malformed = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=..%2Froom.glb&kind=environment");
        malformed.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        malformed.Content = new ByteArrayContent([0]);
        malformed.Content.Headers.ContentType = new("model/gltf-binary");
        using var rejected = await fixture.Client.SendAsync(malformed);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        // Optional review details still enforce the existing text limits when supplied
        foreach (var field in new[] { "source", "license", "reviewNotes" })
        {
            foreach (var value in new[] { new string('x', 2001), "invalid\ntext" })
            {
                using var invalidReview = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{Guid.NewGuid()}/approve",
                    new Dictionary<string, string> { [field] = value });
                await Assert.That(invalidReview.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
            }
        }
        // Reject an oversized body before validation or persistence, even with a valid administrator token
        using var oversized = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=room.glb&kind=environment");
        oversized.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        oversized.Headers.ExpectContinue = true;
        oversized.Content = new ByteArrayContent(new byte[AssetIntakePolicy.MaxBytes + 1]);
        oversized.Content.Headers.ContentType = new("model/gltf-binary");
        using var tooLarge = await fixture.Client.SendAsync(oversized);
        await Assert.That(tooLarge.StatusCode).IsEqualTo(HttpStatusCode.RequestEntityTooLarge);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().AssetCandidates.CountAsync()).IsEqualTo(0);
    }
    [Test]
    [Arguments("hide")]
    [Arguments("delete")]
    public async Task Intake_RetiredRoomRejectsFreshCreationButKeepsExistingCreatorReferences(string retirement)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var creator = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(admin);
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=room.glb&kind=environment");
        upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        upload.Content = new ByteArrayContent(CreateMinimalGlb());
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(candidate.Status).IsEqualTo("approved");

        await fixture.SignInAsync(creator);
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Existing room", environmentAssetId = candidate.Id.ToString() });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projectId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        await fixture.SignInAsync(admin);
        using var retired = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{candidate.Id}/availability",
            new AssetAvailabilityRequest(retirement));
        await Assert.That(retired.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await fixture.SignInAsync(creator);

        using var rejected = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Fresh retired room", environmentAssetId = candidate.Id.ToString() });
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        using var opened = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}");
        await Assert.That(opened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var document = (await opened.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document");
        using var imported = await AuthTestRequests.PostAsync(fixture, "/api/v1/projects/",
            new { title = "Imported retired room", document });
        await Assert.That(imported.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        using var save = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/projects/{projectId}");
        save.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        save.Content = JsonContent.Create(new { expectedRevision = 0, clientMutationId = Guid.NewGuid(), document });
        using var saved = await fixture.Client.SendAsync(save);
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var bytes = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets/{candidate.Id}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await bytes.Content.ReadAsByteArrayAsync()).SequenceEqual(CreateMinimalGlb())).IsTrue();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.ProjectAssignments.CountAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments("environment", 1, false)]
    [Arguments("model", 2, false)]
    [Arguments("audio", 2, false)]
    [Arguments("model", 2, true)]
    public async Task Intake_FinalRemovalCleansDraftsAndPermanentlyRetiresAffectedEditions(string kind, int version, bool expire)
    {
        var expiry = new ExpireRemovalAfterSave();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(expiry)),
            environmentName: "Development");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var creator = await fixture.CreateAccountAsync();
        var assetId = Guid.NewGuid();
        var projectId = Guid.NewGuid();
        var editionId = Guid.NewGuid();
        var json = JsonNode.Parse(ProjectTestDocuments.Create(projectId, "Retained " + assetId, version))!;
        var scene = json["scenes"]![0]!;
        if (kind == "environment")
        {
            scene["environmentAssetId"] = assetId.ToString();
            // Released v1 names and scales can exceed v2 limits before the room is removed
            json["title"] = new string('t', 257);
            scene["name"] = new string('s', 255) + "\U0001F600";
            scene["objects"]![0]!["name"] = new string('o', 257);
            scene["objects"]![0]!["transform"]!["scale"] = new JsonArray(10001, 2, 3);
        }
        if (kind == "model")
        {
            scene["objects"]![0]!["assetId"] = assetId.ToString();
            scene["objects"]![1]!["parentId"] = scene["objects"]![0]!["id"]!.GetValue<string>();
        }
        if (kind == "audio")
        {
            var audio = new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString(),
                ["type"] = "audio",
                ["assetId"] = assetId.ToString(),
                ["caption"] = "Narration",
                ["loop"] = true,
                ["volume"] = 1,
                ["mode"] = "global"
            };
            scene["audio"] = new JsonArray(audio);
            scene["rules"]!.AsArray().Add(new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString(),
                ["enabled"] = true,
                ["trigger"] = new JsonObject { ["type"] = "sceneStart" },
                ["actions"] = new JsonArray(new JsonObject { ["type"] = "playMedia", ["mediaId"] = audio["id"]!.GetValue<string>() })
            });
        }
        var original = json.ToJsonString();
        var bytes = CreateMinimalGlb();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == creator).Select(row => row.OrganizationId).SingleAsync();
            var asset = new AssetCandidate
            {
                Id = assetId,
                Name = "Removal fixture",
                Kind = kind,
                Category = kind == "environment" ? null : kind == "audio" ? "BGM" : "Objects",
                Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
                Bytes = bytes,
                Status = "approved",
                Source = "Fixture",
                License = "Fixture",
                ReviewNotes = "Fixture",
                ValidationJson = "[]",
                SubmittedBy = admin,
                ReviewedBy = admin,
                CreatedAt = DateTimeOffset.UtcNow
            };
            database.AssetCandidates.Add(asset);
            database.Projects.Add(new Project
            {
                Id = projectId,
                OrganizationId = organization,
                SchemaVersion = version,
                DocumentJson = original,
                UpdatedAt = DateTimeOffset.UtcNow
            });
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = projectId, UserId = creator, CanEdit = true, CanPublish = true });
            await database.SaveChangesAsync();
            database.Publications.Add(new Publication
            {
                Id = editionId,
                ProjectId = projectId,
                PublishedById = creator,
                SourceRevision = 0,
                SchemaVersion = version,
                DocumentJson = original,
                RequestDigest = new byte[32],
                AssetReferencesJson = PublicationAssetManifest.Serialize([new(assetId.ToString(), asset.Sha256)])
            });
            database.PublicationAccess.Add(new PublicationAccessState { PublicationId = editionId, Audience = 1 });
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(admin);
        using var notDeleted = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{assetId}/availability", new AssetAvailabilityRequest("remove"));
        await Assert.That(notDeleted.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        using var retired = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{assetId}/availability", new AssetAvailabilityRequest("delete"));
        await Assert.That(retired.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await fixture.SignInAsync(creator);
        using var retained = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets/{assetId}/bytes");
        await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var forbidden = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{assetId}/availability", new AssetAvailabilityRequest("remove", true));
        await Assert.That(forbidden.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await fixture.SignInAsync(admin);
        using var noCsrf = await fixture.Client.PostAsJsonAsync($"/api/v1/admin/assets/{assetId}/availability", new AssetAvailabilityRequest("remove", true));
        await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        if (expire) { expiry.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9)); }
        using var removed = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{assetId}/availability", new AssetAvailabilityRequest("remove", true));
        if (expire)
        {
            await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
            await using var rolledBack = fixture.Database.Services.CreateAsyncScope();
            var state = rolledBack.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That((await state.AssetCandidates.SingleAsync(row => row.Id == assetId)).RemovedFromProjects).IsFalse();
            var unchanged = await state.Projects.SingleAsync(row => row.Id == projectId);
            await Assert.That(unchanged.Revision).IsEqualTo(0L);
            await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(original), JsonNode.Parse(unchanged.DocumentJson))).IsTrue();
            await Assert.That((await state.PublicationAccess.SingleAsync(row => row.PublicationId == editionId)).Deleted).IsFalse();
            await Assert.That(await state.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids WHERE id = {editionId}").AnyAsync()).IsFalse();
            return;
        }
        await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var record = (await removed.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(record.RemovedFromProjects).IsTrue();
        await Assert.That(record.Actions).IsEmpty();
        using var repeated = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{assetId}/availability", new AssetAvailabilityRequest("remove"));
        await Assert.That(repeated.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        await fixture.SignInAsync(creator);
        using var reopened = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}");
        await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var current = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(current.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        var currentJson = current.GetProperty("document").GetRawText();
        await Assert.That(AssetDocumentReferences.Read(currentJson).Contains(assetId.ToString())).IsFalse();
        await Assert.That(current.GetProperty("document").GetProperty("title").GetString()).IsEqualTo(kind == "environment" ? new string('t', 256) : "Retained " + assetId);
        if (kind == "environment")
        {
            var converted = current.GetProperty("document").GetProperty("scenes")[0];
            await Assert.That(converted.GetProperty("name").GetString()).IsEqualTo(new string('s', 255));
            await Assert.That(converted.GetProperty("environmentAssetId").ValueKind).IsEqualTo(JsonValueKind.Null);
            var objects = converted.GetProperty("objects");
            await Assert.That(objects[0].GetProperty("name").GetString()).IsEqualTo(new string('o', 256));
            await Assert.That(objects[0].GetProperty("transform").GetProperty("scale")[0].GetDouble()).IsEqualTo(10000d);
            await Assert.That(objects[0].GetProperty("transform").GetProperty("scale")[1].GetDouble()).IsEqualTo(2d);
            await Assert.That(objects[1].GetProperty("name").GetString()).IsEqualTo(scene["objects"]![1]!["name"]!.GetValue<string>());
        }
        if (kind == "model") { await Assert.That(current.GetProperty("document").GetProperty("scenes")[0].GetProperty("objects").GetArrayLength()).IsEqualTo(0); }
        using var deniedBytes = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/assets/{assetId}/bytes");
        await Assert.That(deniedBytes.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var save = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/projects/{projectId}");
        save.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        save.Content = JsonContent.Create(new { expectedRevision = 1, clientMutationId = Guid.NewGuid(), document = JsonSerializer.Deserialize<JsonElement>(original) });
        using var restored = await fixture.Client.SendAsync(save);
        await Assert.That(restored.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        using var visitor = fixture.CreateClient();
        using var deniedEdition = await visitor.GetAsync($"/api/v1/publications/{editionId}");
        await Assert.That(deniedEdition.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        var stored = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(original),
            JsonNode.Parse((await stored.Publications.SingleAsync(row => row.Id == editionId)).DocumentJson))).IsTrue();
        await Assert.That(AssetDocumentReferences.Read((await stored.Publications.SingleAsync(row => row.Id == editionId)).DocumentJson).Contains(assetId.ToString())).IsTrue();
        await Assert.That((await stored.AssetCandidates.SingleAsync(row => row.Id == assetId)).Bytes.SequenceEqual(bytes)).IsTrue();
        var boundary = new ProjectDocumentService(fixture.App.Environment, stored);
        var history = boundary.ReadStored(projectId, version, original);
        await Assert.That(history.Ok).IsTrue();
        await Assert.That(boundary.Serialize(history.Value!).Ok).IsFalse();
        await Assert.That(boundary.Read(projectId, original, original).Ok).IsFalse();
        await Assert.That(await stored.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids WHERE id = {editionId}").AnyAsync()).IsTrue();
        await Assert.ThrowsAsync<Npgsql.PostgresException>(async () =>
            await stored.PublicationAccess.Where(row => row.PublicationId == editionId)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.Deleted, false)));
        using var stillDenied = await visitor.GetAsync($"/api/v1/publications/{editionId}");
        await Assert.That(stillDenied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    private sealed class ExpireRemovalAfterSave : SaveChangesInterceptor
    {
        internal Action? After;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }

    private static async Task<Guid> SeedLegacyPendingAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var existing = await database.AssetCandidates.AsNoTracking().SingleAsync(asset => asset.Id == id);
        var legacy = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = existing.Name,
            Kind = existing.Kind,
            Category = existing.Category,
            Sha256 = existing.Sha256,
            Bytes = existing.Bytes,
            Status = "pending",
            Hidden = true,
            ValidationJson = existing.ValidationJson,
            SubmittedBy = existing.SubmittedBy,
            CreatedAt = existing.CreatedAt
        };
        database.AssetCandidates.Add(legacy);
        await database.SaveChangesAsync();
        return legacy.Id;
    }

    // Keep API tests independent of Git LFS while exercising the real GLB validator
    internal static byte[] CreateMinimalGlb(string? document = null)
    {
        // Cross the default small JSON-request budget so this also proves the upload route's larger limit applies
        var json = System.Text.Encoding.UTF8.GetBytes(document ?? "{\"asset\":{\"version\":\"2.0\"},\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{}],\"extras\":{\"padding\":\"" + new string('x', 32 * 1024) + "\"}}");
        var padded = (json.Length + 3) & ~3;
        var bytes = new byte[20 + padded];
        using var stream = new MemoryStream(bytes);
        using var writer = new BinaryWriter(stream);
        writer.Write(0x46546c67);
        writer.Write(2);
        writer.Write(bytes.Length);
        writer.Write(padded);
        writer.Write(0x4e4f534a);
        writer.Write(json);
        while (stream.Position < bytes.Length) { writer.Write((byte)' '); }
        return bytes;
    }

}
