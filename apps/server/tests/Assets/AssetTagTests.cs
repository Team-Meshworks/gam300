using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AssetIntakeTests))]
public sealed class AssetTagTests
{
    [Test]
    public async Task AdministratorsTagAssetsReusingExistingTagsAndAddingNewOnes()
    {
        var audio = await File.ReadAllBytesAsync(Path.GetFullPath(
            "../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Production");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var creator = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(admin);

        // The migration seeds the starter tags into the policy importers choose from
        await Assert.That(await PolicyTagsAsync(fixture)).IsEquivalentTo(AssetTags.Starter);

        // "post war" reuses the seeded spelling; "New Era" joins the shared list
        using var upload = await UploadAsync(fixture, audio, ["post war", "Japanese Occupation", "New  Era"]);
        await Assert.That(upload.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var track = (await upload.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        await Assert.That(track.Tags).IsEquivalentTo(new[] { "Post-war", "Japanese Occupation", "New Era" });
        await Assert.That(await PolicyTagsAsync(fixture)).Contains("New Era");
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var added = await database.CatalogueTags.SingleAsync(tag => tag.Key == "newera");
            await Assert.That(added.CreatedBy).IsEqualTo(admin);
            await Assert.That(await database.CatalogueTags.CountAsync()).IsEqualTo(AssetTags.Starter.Length + 1);
        }

        var path = $"/api/v1/admin/assets/{track.Id}/details";
        var details = new AssetDetailsRequest("Calm piano", "audio", "BGM", new("Library", "CC0", "Reviewed"), ["MODERN singapore"]);
        using (var save = await AuthTestRequests.PutAsync(fixture.Client, path, details, await fixture.GetCsrfAsync()))
        {
            await Assert.That(save.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await save.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!.Tags)
                .IsEquivalentTo(new[] { "Modern Singapore" });
        }

        // Editing without tags, as an older client would, leaves them unchanged
        using (var keep = await AuthTestRequests.PutAsync(fixture.Client, path, details with { Tags = null }, await fixture.GetCsrfAsync()))
        {
            await Assert.That((await keep.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!.Tags)
                .IsEquivalentTo(new[] { "Modern Singapore" });
        }

        using (var invalid = await AuthTestRequests.PutAsync(fixture.Client, path, details with { Tags = ["<bad>"] }, await fixture.GetCsrfAsync()))
            await AuthTestRequests.AssertProblemAsync(invalid, HttpStatusCode.BadRequest, "invalid_asset_input");
        using (var invalidUpload = await UploadAsync(fixture, audio, ["<bad>"]))
            await AuthTestRequests.AssertProblemAsync(invalidUpload, HttpStatusCode.BadRequest, "invalid_asset_input");

        // Every signed-in account sees tags in the library catalogue
        await fixture.SignInAsync(creator);
        using var catalogue = await fixture.Client.GetAsync("/api/v1/assets");
        var entry = (await catalogue.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()
            .Single(item => item.GetProperty("id").GetGuid() == track.Id);
        await Assert.That(entry.GetProperty("tags").EnumerateArray().Select(tag => tag.GetString()!).ToArray())
            .IsEquivalentTo(new[] { "Modern Singapore" });
    }

    private static async Task<string[]> PolicyTagsAsync(HttpsApplicationFixture fixture)
    {
        using var response = await fixture.Client.GetAsync("/api/v1/admin/assets");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("policy").GetProperty("tags").EnumerateArray().Select(tag => tag.GetString()!).ToArray();
    }

    private static async Task<HttpResponseMessage> UploadAsync(HttpsApplicationFixture fixture, byte[] audio, string[] tags)
    {
        var query = "/api/v1/admin/assets?name=track.m4a&kind=audio&category=BGM"
            + string.Concat(tags.Select(tag => "&tags=" + Uri.EscapeDataString(tag)));
        using var request = new HttpRequestMessage(HttpMethod.Post, query);
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        request.Content = new ByteArrayContent(audio);
        request.Content.Headers.ContentType = new("audio/mp4");
        return await fixture.Client.SendAsync(request);
    }
}
