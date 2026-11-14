using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AssetIntakeTests))]
public sealed class AssetUploadIdentityTests
{
    [Test]
    public async Task IndependentAdministratorUploadsShareOneCatalogueEntry()
    {
        var arrivals = new IntakeArrivals();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(arrivals)),
            environmentName: "Development");
        var firstActor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var secondActor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var secondProfile = fixture.CreateClient();
        await fixture.SignInAsync(firstActor);
        await fixture.SignInAsync(secondActor, secondProfile);
        var firstToken = await fixture.GetCsrfAsync();
        var secondToken = await fixture.GetCsrfAsync(secondProfile);
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var firstDetails = new AssetReviewRequest("First source", "First license", "First review");
        var secondDetails = new AssetReviewRequest("Second source", "Second license", "Second review");

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync();
        await database.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(167168)");
        var first = UploadAsync(fixture.Client, firstToken, bytes, metadata: firstDetails);
        var second = UploadAsync(secondProfile, secondToken, bytes, metadata: secondDetails);
        try
        {
            await arrivals.Both.Task.WaitAsync(TimeSpan.FromSeconds(10));
        }
        finally
        {
            await transaction.CommitAsync();
        }
        var pair = await Task.WhenAll(first, second);
        using var firstResponse = pair[0];
        using var secondResponse = pair[1];
        var firstAsset = (await firstResponse.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        var secondAsset = (await secondResponse.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(1);
        await Assert.That(firstAsset.Id).IsEqualTo(secondAsset.Id);
        await Assert.That(pair.Count(response => response.StatusCode == HttpStatusCode.Created)).IsEqualTo(1);
        await Assert.That(pair.Count(response => response.StatusCode == HttpStatusCode.OK)).IsEqualTo(1);
        var firstCreated = firstResponse.StatusCode == HttpStatusCode.Created;
        var original = firstCreated ? firstDetails : secondDetails;
        var persisted = await database.AssetCandidates.SingleAsync();
        await Assert.That(persisted.SubmittedBy).IsEqualTo(firstCreated ? firstActor : secondActor);
        await Assert.That(firstAsset.Source == original.Source && secondAsset.Source == original.Source).IsTrue();
        await Assert.That(persisted.License).IsEqualTo(original.License);
        await Assert.That(persisted.ReviewNotes).IsEqualTo(original.ReviewNotes);

        // Same bytes can still back a differently labelled or categorized asset; changed bytes are a new version.
        await CreateDistinctAsync(bytes, "Other.glb", "model", "Objects");
        await CreateDistinctAsync(bytes, "Exhibit.glb", "model", "Furniture");
        await CreateDistinctAsync(bytes, "Exhibit.glb", "environment", null);
        await CreateDistinctAsync(AssetIntakeTests.CreateMinimalGlb("""{"asset":{"version":"2.0"}}"""),
            "Exhibit.glb", "model", "Objects");
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(5);

        async Task CreateDistinctAsync(byte[] content, string name, string kind, string? category)
        {
            using var response = await UploadAsync(secondProfile, secondToken, content, name, kind, category);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
    }

    [Test]
    public async Task RetriesReturnTheHistoricalCandidateThroughReviewAndRetirement()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        var token = await fixture.GetCsrfAsync();
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        // Historical duplicates are valid referenced rows. Equal timestamps use database UUID order.
        var originalId = Guid.Parse("10000000-0000-4000-8000-000000000001");
        var duplicateId = Guid.Parse("20000000-0000-4000-8000-000000000002");
        var createdAt = DateTimeOffset.UtcNow;
        foreach (var id in new[] { duplicateId, originalId })
        {
            database.AssetCandidates.Add(new AssetCandidate
            {
                Id = id,
                Name = "Exhibit",
                Kind = "model",
                Category = "Objects",
                Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
                Bytes = bytes,
                Status = "pending",
                Hidden = true,
                ValidationJson = "[]",
                SubmittedBy = admin,
                CreatedAt = createdAt
            });
        }
        await database.SaveChangesAsync();
        var pending = await ReplayAsync();
        await Assert.That(pending.Status).IsEqualTo("pending");
        var review = new AssetReviewRequest("Reviewed source", "Reviewed license", "Reviewed notes");
        using var approved = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{originalId}/approve", review, token: token);
        await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var current = await ReplayAsync();
        await Assert.That(current.Source).IsEqualTo(review.Source);
        await Assert.That(current.License).IsEqualTo(review.License);
        await Assert.That(current.ReviewNotes).IsEqualTo(review.ReviewNotes);
        foreach (var action in new[] { "hide", "delete", "remove" })
        {
            using var changed = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{originalId}/availability",
                new AssetAvailabilityRequest(action, action == "remove"), token: token);
            await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.OK);
            current = await ReplayAsync();
            await Assert.That(current.Hidden).IsTrue();
            await Assert.That(current.Deleted).IsEqualTo(action != "hide");
            await Assert.That(current.RemovedFromProjects).IsEqualTo(action == "remove");
        }
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(2);
        await Assert.That(await database.AssetCandidates.Where(asset => asset.Id == duplicateId)
            .Select(asset => asset.Status).SingleAsync()).IsEqualTo("pending");

        async Task<AssetAdministrationRecord> ReplayAsync()
        {
            using var replay = await UploadAsync(fixture.Client, token, bytes, "Exhibit.GLB",
                metadata: new AssetReviewRequest("Other source", "Other license", "Other notes"));
            await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var asset = (await replay.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
            await Assert.That(asset.Id).IsEqualTo(originalId);
            return asset;
        }
    }

    [Test]
    public async Task RetryingAnInvalidPrivateCandidateAtCapacityDoesNotChargeQuotaAgain()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        byte[] bytes = [1, 2, 3];
        using var first = await UploadAsync(fixture.Client, token, bytes);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var original = (await first.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(original.Status).IsEqualTo("invalid");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO asset_candidates (id, name, kind, category, sha256, bytes, status, validation, hidden,
                deleted, removed_from_projects, submitted_by, created_at)
            SELECT gen_random_uuid(), 'Quota ' || n, 'model', 'Objects', {original.Sha256}, {bytes}, 'invalid',
                '[]'::jsonb, true, false, false, {actor}, now() FROM generate_series(1, 999) AS n
            """);
        using var replay = await UploadAsync(fixture.Client, token, bytes);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var privateAsset = (await replay.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(privateAsset.Id).IsEqualTo(original.Id);
        await Assert.That(privateAsset.Hidden && privateAsset.Status == "invalid").IsTrue();
        using var other = await UploadAsync(fixture.Client, token, bytes, "Other.glb");
        await AuthTestRequests.AssertProblemAsync(other, HttpStatusCode.ServiceUnavailable, "asset_intake_unavailable");
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(1000);
    }

    private static async Task<HttpResponseMessage> UploadAsync(HttpClient client, string token, byte[] bytes,
        string name = "Exhibit.glb", string kind = "model", string? category = "Objects", AssetReviewRequest? metadata = null)
    {
        var path = $"/api/v1/admin/assets?name={name}&kind={kind}" + (category is null ? "" : $"&category={category}");
        using var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Headers.Add("X-CSRF-TOKEN", token);
        if (metadata is not null)
        {
            request.Headers.Add("X-Spatia-Asset-Metadata", Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(metadata)));
        }
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new("model/gltf-binary");
        return await client.SendAsync(request);
    }

    private sealed class IntakeArrivals : DbCommandInterceptor
    {
        private int _arrived;
        public TaskCompletionSource Both { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("pg_advisory_xact_lock(167168)", StringComparison.Ordinal)
                && Interlocked.Increment(ref _arrived) == 2)
            {
                Both.TrySetResult();
            }
            return ValueTask.FromResult(result);
        }
    }
}
