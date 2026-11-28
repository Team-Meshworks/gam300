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
    public async Task SupplementaryLettersAreValidTagsAsInTheBrowser()
    {
        // CJK Extension B sits outside the BMP, so it arrives as a surrogate pair
        await Assert.That(AssetTags.Normalize("\U00020000 Kampong")).IsEqualTo("\U00020000 Kampong");
        await Assert.That(AssetTags.Key("\U00020000 Kampong")).IsEqualTo("\U00020000kampong");
    }

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
        using (var keep = await AuthTestRequests.PutAsync(fixture.Client, path, details with
        {
            Tags = null
        }, await fixture.GetCsrfAsync()))
        {
            await Assert.That((await keep.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!.Tags)
                .IsEquivalentTo(new[] { "Modern Singapore" });
        }

        using (var invalid = await AuthTestRequests.PutAsync(fixture.Client, path, details with
        {
            Tags = ["<bad>"]
        }, await fixture.GetCsrfAsync()))
        {
            await AuthTestRequests.AssertProblemAsync(invalid, HttpStatusCode.BadRequest, "invalid_asset_input");
        }

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

    [Test]
    public async Task RemovingOneTagKeepsNewerEditsFromAnotherAdministrator()
    {
        var audio = await File.ReadAllBytesAsync(Path.GetFullPath(
            "../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Production");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);

        using var upload = await UploadAsync(fixture, audio, ["Post-war", "Early Singapore"]);
        var track = (await upload.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;

        // Another admin renames the asset and adds a tag after this dialog opened with the old details
        var newer = new AssetDetailsRequest("Renamed piano", "audio", "BGM", new("Archive", "CC0", "Checked"),
            ["Post-war", "Early Singapore", "Modern Singapore"]);
        using (var save = await AuthTestRequests.PutAsync(fixture.Client, $"/api/v1/admin/assets/{track.Id}/details", newer, await fixture.GetCsrfAsync()))
            await Assert.That(save.StatusCode).IsEqualTo(HttpStatusCode.OK);

        // The stale dialog's X names only the tag, so the newer name, provenance and tag survive
        var path = $"/api/v1/admin/assets/{track.Id}/tags/remove";
        using (var remove = await AuthTestRequests.PostAsync(fixture, path, new AssetTagRemovalRequest("post war")))
        {
            await Assert.That(remove.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var record = (await remove.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
            await Assert.That(record.Name).IsEqualTo("Renamed piano");
            await Assert.That(record.Source).IsEqualTo("Archive");
            await Assert.That(record.Tags).IsEquivalentTo(new[] { "Early Singapore", "Modern Singapore" });
        }

        // Removing a tag the asset no longer has changes nothing
        using (var again = await AuthTestRequests.PostAsync(fixture, path, new AssetTagRemovalRequest("Post-war")))
        {
            await Assert.That(again.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await again.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!.Tags)
                .IsEquivalentTo(new[] { "Early Singapore", "Modern Singapore" });
        }

        using (var invalid = await AuthTestRequests.PostAsync(fixture, path, new AssetTagRemovalRequest("<bad>")))
            await AuthTestRequests.AssertProblemAsync(invalid, HttpStatusCode.BadRequest, "invalid_asset_input");
        using (var missing = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{Guid.NewGuid()}/tags/remove", new AssetTagRemovalRequest("Post-war")))
            await AuthTestRequests.AssertProblemAsync(missing, HttpStatusCode.Conflict, "asset_conflict");
    }

    [Test]
    public async Task DetailsEditsKeepOtherAdministratorsTagChangesOrAreRejectedWhenStale()
    {
        var audio = await File.ReadAllBytesAsync(Path.GetFullPath(
            "../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Production");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);

        using var upload = await UploadAsync(fixture, audio, ["Post-war", "Early Singapore"]);
        var track = (await upload.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
        var path = $"/api/v1/admin/assets/{track.Id}/details";
        // The first admin's edit form opened with these details
        var opened = new AssetDetailsSnapshot(track.Name, track.Category, new(track.Source, track.License, track.ReviewNotes), track.Tags);

        // A second admin removes a tag
        using (var removed = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{track.Id}/tags/remove", new AssetTagRemovalRequest("Post-war")))
            await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.OK);

        // A rename that leaves tags alone omits them, so the removal is not undone
        var rename = new AssetDetailsRequest("Renamed piano", "audio", track.Category, new(track.Source, track.License, track.ReviewNotes),
            Expected: opened);
        using (var save = await AuthTestRequests.PutAsync(fixture.Client, path, rename, await fixture.GetCsrfAsync()))
        {
            await Assert.That(save.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var record = (await save.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;
            await Assert.That(record.Name).IsEqualTo("Renamed piano");
            await Assert.That(record.Tags).IsEquivalentTo(new[] { "Early Singapore" });
        }

        // A tag edit from the same stale form would restore the removed tag, so it is rejected
        var staleTags = rename with
        {
            Name = track.Name,
            Tags = ["Post-war", "Early Singapore", "Modern Singapore"]
        };
        using (var stale = await AuthTestRequests.PutAsync(fixture.Client, path, staleTags, await fixture.GetCsrfAsync()))
            await AuthTestRequests.AssertProblemAsync(stale, HttpStatusCode.Conflict, "asset_stale");

        // So is a save that would overwrite the newer name, even without tags
        using (var staleName = await AuthTestRequests.PutAsync(fixture.Client, path, rename with
        {
            Name = "Another name"
        }, await fixture.GetCsrfAsync()))
        {
            await AuthTestRequests.AssertProblemAsync(staleName, HttpStatusCode.Conflict, "asset_stale");
        }

        // After reloading, the tag edit goes through against the current details
        var reloaded = new AssetDetailsSnapshot("Renamed piano", track.Category, new(track.Source, track.License, track.ReviewNotes), ["Early Singapore"]);
        var fresh = rename with
        {
            Tags = ["Early Singapore", "Modern Singapore"],
            Expected = reloaded
        };
        using (var save = await AuthTestRequests.PutAsync(fixture.Client, path, fresh, await fixture.GetCsrfAsync()))
        {
            await Assert.That(save.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await save.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!.Tags)
                .IsEquivalentTo(new[] { "Early Singapore", "Modern Singapore" });
        }
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
