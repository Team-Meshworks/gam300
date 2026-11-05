using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AssetIntakeTests
{
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
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/admin/assets?name=invalid.glb&kind=model&category=Objects");
        upload.Headers.Add("X-CSRF-TOKEN", token);
        upload.Content = new ByteArrayContent(CreateMinimalGlb(document));
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(candidate.Status).IsEqualTo("invalid");

        // Retain private diagnostics for inspection while preventing review from approving incomplete validation
        using var review = new HttpRequestMessage(HttpMethod.Post, $"/api/admin/assets/{candidate.Id}/approve");
        review.Headers.Add("X-CSRF-TOKEN", token);
        review.Content = JsonContent.Create(new AssetReviewRequest("Synthetic source", "Synthetic rights", "Synthetic review"));
        using var rejected = await fixture.Client.SendAsync(review);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        using var bytes = await fixture.Client.GetAsync($"/api/assets/{candidate.Id}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
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
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/admin/assets?name=room.glb&kind=environment");
        upload.Headers.Add("X-CSRF-TOKEN", token);
        upload.Content = new ByteArrayContent(bytes);
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>();
        await Assert.That(candidate!.Status).IsEqualTo("pending");
        using var inspection = await fixture.Client.GetAsync(candidate.InspectionUrl);
        await Assert.That(inspection.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(inspection.Content.Headers.ContentDisposition!.DispositionType).IsEqualTo("attachment");
        await Assert.That((await inspection.Content.ReadAsByteArrayAsync()).SequenceEqual(bytes)).IsTrue();
        // Pending bytes never enter the student catalogue even for an unrestricted account
        using var pending = await fixture.Client.GetAsync($"/api/assets/{candidate.Id}/bytes");
        await Assert.That(pending.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var review = new HttpRequestMessage(HttpMethod.Post, $"/api/admin/assets/{candidate.Id}/approve");
        review.Headers.Add("X-CSRF-TOKEN", token);
        // Escaped Unicode can exceed the default small-request budget while every field is still valid
        var reviewText = new string((char)0x754c, 2000);
        review.Content = JsonContent.Create(new AssetReviewRequest(reviewText, reviewText, reviewText));
        using var approved = await fixture.Client.SendAsync(review);
        await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var available = await fixture.Client.GetAsync($"/api/assets/{candidate.Id}/bytes");
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
            using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{projectId}");
            request.Headers.Add("X-CSRF-TOKEN", token);
            request.Content = JsonContent.Create(new { expectedRevision = revision, clientMutationId = mutation, document = parsed.RootElement });
            return await fixture.Client.SendAsync(request);
        }
        var originalMutation = Guid.NewGuid();
        using var originalSave = await SaveAsync(json, 0, originalMutation);
        await Assert.That(originalSave.StatusCode).IsEqualTo(HttpStatusCode.OK);
        // Ordinary deletion changes discovery while preserving the immutable row and audit metadata
        using var deletion = new HttpRequestMessage(HttpMethod.Post, $"/api/admin/assets/{candidate.Id}/availability");
        deletion.Headers.Add("X-CSRF-TOKEN", token);
        deletion.Content = JsonContent.Create(new AssetAvailabilityRequest("delete"));
        using var deleted = await fixture.Client.SendAsync(deletion);
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var hiddenBytes = await fixture.Client.GetAsync($"/api/assets/{candidate.Id}/bytes");
        await Assert.That(hiddenBytes.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await database.AssetCandidates.AsNoTracking().SingleAsync();
        await Assert.That(stored.Deleted && stored.Hidden).IsTrue();
        await Assert.That(stored.Bytes.SequenceEqual(bytes)).IsTrue();
        await Assert.That(stored.ReviewedBy).IsEqualTo((Guid?)admin);
        await Assert.That(stored.Source).IsEqualTo(reviewText);
        // Stored documents keep their exact reference while new imports cannot select a retired version
        var documents = new ProjectDocumentService(fixture.App.Environment, database);
        await Assert.That(documents.ReadStored(projectId, 1, json).Ok).IsTrue();
        await Assert.That(documents.Read(projectId, json, json).Ok).IsTrue();
        await Assert.That(documents.Read(json).Ok).IsFalse();
        using var retained = await fixture.Client.GetAsync($"/api/projects/{projectId}/assets/{candidate.Id}/bytes");
        await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await retained.Content.ReadAsByteArrayAsync()).SequenceEqual(bytes)).IsTrue();
        using var unrelated = await fixture.Client.GetAsync($"/api/projects/{Guid.NewGuid()}/assets/{candidate.Id}/bytes");
        await Assert.That(unrelated.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        // Existing references remain saveable after retirement while an old retry acknowledges only its original commit
        using var retainedSave = await SaveAsync(json, 1, Guid.NewGuid());
        await Assert.That(retainedSave.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var withoutRetired = ProjectTestDocuments.Create(projectId, "Newer draft without retired asset");
        using var newerSave = await SaveAsync(withoutRetired, 2, Guid.NewGuid());
        await Assert.That(newerSave.StatusCode).IsEqualTo(HttpStatusCode.OK);
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
        // No publication integration means a global removal must deny without changing the retained row
        using var removal = new HttpRequestMessage(HttpMethod.Post, $"/api/admin/assets/{candidate.Id}/availability");
        removal.Headers.Add("X-CSRF-TOKEN", token);
        removal.Content = JsonContent.Create(new AssetAvailabilityRequest("remove", true));
        using var unavailable = await fixture.Client.SendAsync(removal);
        await Assert.That(unavailable.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        await Assert.That((await database.AssetCandidates.AsNoTracking().SingleAsync()).RemovedFromProjects).IsFalse();
        // Database enforcement prevents later writers from replacing a reviewed version's bytes
        await Assert.ThrowsAsync<Npgsql.PostgresException>(async () => await database.Database.ExecuteSqlRawAsync("UPDATE asset_candidates SET bytes = decode('00', 'hex')"));
    }

    [Test]
    public async Task Intake_RequiresCurrentAdministratorAndCsrfAndRejectsMalformedMetadata()
    {
        // Reject anonymous and creator sessions before proving an administrator still needs a current CSRF token
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var anonymous = await fixture.Client.GetAsync("/api/admin/assets");
        await Assert.That(anonymous.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var creator = await fixture.Client.GetAsync("/api/admin/assets");
        await Assert.That(creator.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var deniedInspection = await fixture.Client.GetAsync($"/api/admin/assets/{Guid.NewGuid()}/bytes");
        await Assert.That(deniedInspection.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        using var noCsrf = await fixture.Client.PostAsJsonAsync($"/api/admin/assets/{Guid.NewGuid()}/availability", new AssetAvailabilityRequest("delete"));
        await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var malformed = new HttpRequestMessage(HttpMethod.Post, "/api/admin/assets?name=..%2Froom.glb&kind=environment");
        malformed.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        malformed.Content = new ByteArrayContent([0]);
        malformed.Content.Headers.ContentType = new("model/gltf-binary");
        using var rejected = await fixture.Client.SendAsync(malformed);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        // Reject an oversized body before validation or persistence, even with a valid administrator token
        using var oversized = new HttpRequestMessage(HttpMethod.Post, "/api/admin/assets?name=room.glb&kind=environment");
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
        using var upload = new HttpRequestMessage(HttpMethod.Post, "/api/admin/assets?name=room.glb&kind=environment");
        upload.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        upload.Content = new ByteArrayContent(CreateMinimalGlb());
        upload.Content.Headers.ContentType = new("model/gltf-binary");
        using var submitted = await fixture.Client.SendAsync(upload);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var candidate = (await submitted.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        using var reviewed = await AuthTestRequests.PostAsync(fixture, $"/api/admin/assets/{candidate.Id}/approve",
            new AssetReviewRequest("Synthetic source", "Synthetic rights", "Reviewed room"));
        await Assert.That(reviewed.StatusCode).IsEqualTo(HttpStatusCode.OK);

        await fixture.SignInAsync(creator);
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/projects/",
            new { title = "Existing room", environmentAssetId = candidate.Id.ToString() });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projectId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        await fixture.SignInAsync(admin);
        using var retired = await AuthTestRequests.PostAsync(fixture, $"/api/admin/assets/{candidate.Id}/availability",
            new AssetAvailabilityRequest(retirement));
        await Assert.That(retired.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await fixture.SignInAsync(creator);

        using var rejected = await AuthTestRequests.PostAsync(fixture, "/api/projects/",
            new { title = "Fresh retired room", environmentAssetId = candidate.Id.ToString() });
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        using var opened = await fixture.Client.GetAsync($"/api/projects/{projectId}");
        await Assert.That(opened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var document = (await opened.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document");
        using var imported = await AuthTestRequests.PostAsync(fixture, "/api/projects/",
            new { title = "Imported retired room", document });
        await Assert.That(imported.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        using var save = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{projectId}");
        save.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        save.Content = JsonContent.Create(new { expectedRevision = 0, clientMutationId = Guid.NewGuid(), document });
        using var saved = await fixture.Client.SendAsync(save);
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var bytes = await fixture.Client.GetAsync($"/api/projects/{projectId}/assets/{candidate.Id}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await bytes.Content.ReadAsByteArrayAsync()).SequenceEqual(CreateMinimalGlb())).IsTrue();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.ProjectAssignments.CountAsync()).IsEqualTo(1);
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
