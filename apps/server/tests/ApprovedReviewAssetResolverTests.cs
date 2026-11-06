using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ApprovedReviewAssetResolverTests
{
    [Test]
    [Arguments(1, "active")]
    [Arguments(2, "hidden")]
    [Arguments(2, "deleted")]
    public async Task Submission_RecordsRealApprovedVersionsAndPreservesRetiredEvidence(int version, string lifecycle)
    {
        // Use the production registration and existing class fixture without substituting an asset resolver
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var student = await ReviewSubmissionEndpointTests.SeedAsync(fixture, false);
        var room = Candidate("environment", student.Educator);
        var model = Candidate("model", student.Educator);
        model.Hidden = lifecycle != "active";
        model.Deleted = lifecycle == "deleted";
        var original = ProjectTestDocuments.Create(student.ProjectId, "Submitted exhibit", version)
            .Replace("test-room-v1", room.Id.ToString(), StringComparison.Ordinal)
            .Replace("test-crate-v1", model.Id.ToString(), StringComparison.Ordinal);

        // Seed reviewed versions directly; intake tests already cover validation and the human approval endpoint
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.AssetCandidates.AddRange(room, model);
            var project = await database.Projects.SingleAsync(row => row.Id == student.ProjectId);
            project.DocumentJson = original;
            project.SchemaVersion = version;
            await database.SaveChangesAsync();
        }

        // Submit the confirmed saved revision through the real authenticated route
        var submissionId = Guid.NewGuid();
        using var submitted = await ReviewSubmissionEndpointTests.SubmitAsync(fixture, student.ProjectId, submissionId, 0, true);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var evidence = await database.ReviewSubmissions.AsNoTracking().SingleAsync();
            using var manifest = JsonDocument.Parse(evidence.AssetReferencesJson);
            var actual = manifest.RootElement.EnumerateArray().ToDictionary(
                row => row.GetProperty("assetId").GetString()!, row => row.GetProperty("sha256").GetString());
            await Assert.That(actual.Count).IsEqualTo(2);
            await Assert.That(actual[room.Id.ToString()]).IsEqualTo(room.Sha256);
            await Assert.That(actual[model.Id.ToString()]).IsEqualTo(model.Sha256);
        }

        // Later edits and retries retain the original review evidence rather than resolving a replacement version
        using var edited = await ReviewSubmissionEndpointTests.SaveAsync(fixture, student.ProjectId, 0,
            original.Replace("Submitted exhibit", "Edited exhibit", StringComparison.Ordinal));
        await Assert.That(edited.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var replay = await ReviewSubmissionEndpointTests.SubmitAsync(fixture, student.ProjectId, submissionId, 0, true);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await fixture.SignInAsync(student.Educator);
        using var detail = await fixture.Client.GetAsync($"/api/projects/{student.ProjectId}/submissions/{submissionId}");
        await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var response = await detail.Content.ReadFromJsonAsync<JsonElement>();
        using var expected = JsonDocument.Parse(original);
        await Assert.That(JsonElement.DeepEquals(response.GetProperty("document"), expected.RootElement)).IsTrue();
    }

    [Test]
    [Arguments("pending")]
    [Arguments("invalid")]
    [Arguments("removed")]
    [Arguments("missing")]
    [Arguments("alias")]
    [Arguments("sample")]
    public async Task Resolver_RejectsIncompleteVersionsAndLeavesTheCallerTransactionIntact(string unavailable)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var actor = await fixture.CreateAccountAsync();
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var resolver = scope.ServiceProvider.GetRequiredService<IReviewAssetResolver>();
        var room = Candidate("environment", actor);
        var model = Candidate("model", actor);
        if (unavailable == "alias") { model.Id = Guid.Parse("abcdefab-1234-4abc-8abc-0123456789ab"); }
        if (unavailable is "pending" or "invalid") { model.Status = unavailable; }
        if (unavailable == "removed")
        {
            model.Hidden = true;
            model.Deleted = true;
            model.RemovedFromProjects = true;
        }

        // An uncommitted catalogue version is visible in the existing transaction without granting the resolver commit ownership
        await using var transaction = await database.Database.BeginTransactionAsync();
        database.AssetCandidates.AddRange(room, model);
        await database.SaveChangesAsync();
        var requestedModel = unavailable switch
        {
            "missing" => Guid.NewGuid().ToString(),
            "alias" => model.Id.ToString().ToUpperInvariant(),
            "sample" => "test-crate-v1",
            _ => model.Id.ToString(),
        };
        var required = new HashSet<string>([room.Id.ToString(), requestedModel], StringComparer.Ordinal);
        var project = new ProjectAccessSnapshot(actor, Guid.NewGuid(), Guid.NewGuid(), false, 0, 1, "{}",
            DateTimeOffset.UnixEpoch, null, null, null, true, false, false);
        var resolved = await resolver.ResolveAsync(database, project, required, default);
        await Assert.That(resolved).IsNull();
        await Assert.That(ReferenceEquals(database.Database.CurrentTransaction, transaction)).IsTrue();

        // Reject the whole manifest and leave every write available for the caller to roll back
        await transaction.RollbackAsync();
        await Assert.That(await database.AssetCandidates.AsNoTracking().CountAsync()).IsEqualTo(0);
        await Assert.That(await database.ReviewSubmissions.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task PackagedDevelopmentAssets_RemainUnavailableInProduction()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var actor = await fixture.CreateAccountAsync();
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var room = Candidate("environment", actor);
        var model = Candidate("model", actor);
        database.AssetCandidates.AddRange(room, model);
        await database.SaveChangesAsync();

        var environment = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" }).Environment;
        var production = new ProjectDocumentService(environment, database);
        var projectId = Guid.NewGuid();
        var baseline = ProjectTestDocuments.Create(projectId, "Approved production assets")
            .Replace("test-room-v1", room.Id.ToString(), StringComparison.Ordinal)
            .Replace("test-crate-v1", model.Id.ToString(), StringComparison.Ordinal);
        await Assert.That(production.Read(projectId, baseline).Ok).IsTrue();

        var rooms = new[] { "room-space1-v1", "room-doors-1-v1", "room-doors-2-v1", "room-doors-3-v1", "room-doors-4-v1",
            "room-doors-1-2-v1", "room-doors-1-3-v1", "room-doors-1-4-v1", "room-doors-2-3-v1", "room-doors-2-4-v1",
            "room-doors-3-4-v1", "room-doors-1-2-3-v1", "room-doors-1-2-4-v1", "room-doors-1-3-4-v1",
            "room-doors-2-3-4-v1", "room-doors-1-2-3-4-v1" };
        foreach (var id in rooms)
        {
            var result = production.Read(projectId, baseline.Replace(room.Id.ToString(), id, StringComparison.Ordinal));
            await Assert.That(result.Ok).IsFalse();
            await Assert.That(result.Error!.Path).IsEqualTo("project.scenes[0].environmentAssetId");
        }
        var library = production.Read(projectId, baseline.Replace(model.Id.ToString(), "library-untitled-v1", StringComparison.Ordinal));
        await Assert.That(library.Ok).IsFalse();
        await Assert.That(library.Error!.Path).IsEqualTo("project.scenes[0].objects[0].assetId");
    }

    private static AssetCandidate Candidate(string kind, Guid actor)
    {
        // Distinct synthetic byte sequences make the persisted fingerprints meaningful in the manifest assertion
        byte[] bytes = kind == "environment" ? [1, 2, 3] : [4, 5, 6];
        return new()
        {
            Id = Guid.NewGuid(),
            Name = "Reviewed " + kind,
            Kind = kind,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            Bytes = bytes,
            Status = "approved",
            ValidationJson = "[]",
            Hidden = false,
            Source = "Synthetic review fixture",
            License = "Synthetic fixture only",
            ReviewNotes = "Approved test version",
            SubmittedBy = actor,
            ReviewedBy = actor,
            CreatedAt = DateTimeOffset.UtcNow,
        };
    }
}
