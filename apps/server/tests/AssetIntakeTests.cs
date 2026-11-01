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
    // Keep API tests independent of Git LFS while exercising the real GLB validator
    private static byte[] CreateMinimalGlb()
    {
        // Cross the default small JSON-request budget so this also proves the upload route's larger limit applies
        var json = System.Text.Encoding.UTF8.GetBytes("{\"asset\":{\"version\":\"2.0\"},\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{}],\"extras\":{\"padding\":\"" + new string('x', 32 * 1024) + "\"}}");
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
