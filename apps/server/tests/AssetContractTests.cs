using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AssetIntakeTests))]
public sealed class AssetContractTests
{
    [Test]
    [Arguments("AssetIntake:MaxRetainedAssets", "0")]
    [Arguments("AssetIntake:MaxRetainedAssets", "100001")]
    [Arguments("AssetIntake:MaxRetainedBytes", "0")]
    [Arguments("AssetIntake:MaxRetainedBytes", "-1")]
    public async Task InvalidOperatorCapacityFailsBeforeServingRequests(string key, string value)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { [key] = value }).Build();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            if (key.EndsWith("Assets", StringComparison.Ordinal)) { _ = AssetIntakePolicy.MaxRetainedAssets(configuration); }
            else { _ = AssetIntakePolicy.MaxRetainedBytes(configuration); }
            return Task.CompletedTask;
        });
    }

    [Test]
    [Arguments("MODEL/GLTF-BINARY", "Test.glb", 201)]
    [Arguments("model/gltf-binary; charset=utf-8", "Test.glb", 201)]
    [Arguments("application/octet-stream", "Test.glb", 415)]
    [Arguments("audio/mp4", "Test.glb", 415)]
    [Arguments("application/octet-stream", "Test.txt", 400)]
    public async Task UploadParsesMediaTypesSeparatelyFromMetadata(string mediaType, string name, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/admin/assets?name={name}&kind=model&category=Objects");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        request.Content = new ByteArrayContent(AssetIntakeTests.CreateMinimalGlb());
        request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse(mediaType);
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That((int)response.StatusCode).IsEqualTo(status);
        if (status == 415) { await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.UnsupportedMediaType, "unsupported_media_type"); }
        if (status == 400) { await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.BadRequest, "invalid_asset_input"); }
    }

    [Test]
    public async Task IncreasingOperatorCapacityKeepsBothCataloguesCompleteAndBytesRetained()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Configuration["AssetIntake:MaxRetainedAssets"] = "1001", environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(actor);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        byte[] bytes = [1, 2, 3];
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO asset_candidates (id, name, kind, category, sha256, bytes, status, validation, hidden,
                deleted, removed_from_projects, submitted_by, reviewed_by, source, license, review_notes, created_at)
            SELECT gen_random_uuid(), 'Capacity ' || n, 'model', 'Objects', {new string('a', 64)}, {bytes}, 'approved',
                '[]'::jsonb, false, false, false, {actor}, {actor}, '', '', '', now() FROM generate_series(1, 1000) AS n
            """);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=New.glb&kind=model&category=Objects");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        request.Content = new ByteArrayContent(AssetIntakeTests.CreateMinimalGlb());
        request.Content.Headers.ContentType = new("model/gltf-binary");
        using var uploaded = await fixture.Client.SendAsync(request);
        await Assert.That(uploaded.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var admin = await fixture.Client.GetAsync("/api/v1/admin/assets");
        var data = await admin.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(data.GetProperty("assets").GetArrayLength()).IsEqualTo(1001);
        using var catalogue = await fixture.Client.GetAsync("/api/v1/assets");
        await Assert.That((await catalogue.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(1001);
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(1001);
        await Assert.That(await database.AssetCandidates.CountAsync(asset => asset.Bytes.Length == 3)).IsEqualTo(1000);
    }

    [Test]
    public async Task LoweringIntakeCapacityKeepsBothCataloguesAndHistoricalReplayAvailable()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Configuration["AssetIntake:MaxRetainedAssets"] = "2", environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(actor);
        using var first = await UploadAsync(fixture, "First.glb");
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var original = (await first.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        using var second = await UploadAsync(fixture, "Second.glb");
        await Assert.That(second.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await using var reduced = await fixture.CreateSiblingAsync(builder =>
            builder.Configuration["AssetIntake:MaxRetainedAssets"] = "1");
        await reduced.SignInAsync(actor);
        using var admin = await reduced.Client.GetAsync("/api/v1/admin/assets");
        await Assert.That((await admin.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("assets").GetArrayLength()).IsEqualTo(2);
        using var catalogue = await reduced.Client.GetAsync("/api/v1/assets");
        await Assert.That((await catalogue.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(2);
        using var replay = await UploadAsync(reduced, "First.glb");
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await replay.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!.Id).IsEqualTo(original.Id);
        using var blocked = await UploadAsync(reduced, "Third.glb");
        await AuthTestRequests.AssertProblemAsync(blocked, HttpStatusCode.Conflict, "asset_quota_exceeded");

        static async Task<HttpResponseMessage> UploadAsync(HttpsApplicationFixture app, string name)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/admin/assets?name={name}&kind=model&category=Objects");
            request.Headers.Add("X-CSRF-TOKEN", await app.GetCsrfAsync());
            request.Content = new ByteArrayContent(AssetIntakeTests.CreateMinimalGlb());
            request.Content.Headers.ContentType = new("model/gltf-binary");
            return await app.Client.SendAsync(request);
        }
    }

    [Test]
    public async Task RetainedByteQuotaIsNontransientAndAnOperatorCanRaiseIt()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Configuration["AssetIntake:MaxRetainedBytes"] = "3", environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(actor);
        using var first = await UploadAsync(fixture);
        await AuthTestRequests.AssertProblemAsync(first, HttpStatusCode.Conflict, "asset_quota_exceeded");
        await using var reopened = await fixture.CreateSiblingAsync(builder =>
            builder.Configuration["AssetIntake:MaxRetainedBytes"] = "1073741824");
        await reopened.SignInAsync(actor);
        using var retried = await UploadAsync(reopened);
        await Assert.That(retried.StatusCode).IsEqualTo(HttpStatusCode.Created);

        static async Task<HttpResponseMessage> UploadAsync(HttpsApplicationFixture app)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/admin/assets?name=New.glb&kind=model&category=Objects");
            request.Headers.Add("X-CSRF-TOKEN", await app.GetCsrfAsync());
            request.Content = new ByteArrayContent(AssetIntakeTests.CreateMinimalGlb());
            request.Content.Headers.ContentType = new("model/gltf-binary");
            return await app.Client.SendAsync(request);
        }
    }
}
