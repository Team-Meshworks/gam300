using System.Globalization;
using System.Text.Json;
using Spatia.ProjectFormat;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

public sealed class PublicationRequestTests
{
    [Test]
    [Arguments("id")]
    [Arguments("project")]
    [Arguments("actor")]
    [Arguments("revision")]
    [Arguments("intent")]
    [Arguments("whitespace")]
    [Arguments("key-order")]
    [Arguments("number-spelling")]
    [Arguments("extra-field")]
    public async Task PublicationRequest_DigestBindsEveryOriginalInput(string change)
    {
        var id = Guid.NewGuid();
        var project = Guid.NewGuid();
        var actor = Guid.NewGuid();
        const string intent = "{\"mode\":\"test\",\"schema\":1}";
        var original = new PublicationRequest(id, 1234, intent).Digest(project, actor);
        var altered = new PublicationRequest(change == "id" ? Guid.NewGuid() : id, change == "revision" ? 1235 : 1234,
            change switch
            {
                "intent" => "{\"mode\":\"different\",\"schema\":1}",
                "whitespace" => " " + intent,
                "key-order" => "{\"schema\":1,\"mode\":\"test\"}",
                "number-spelling" => "{\"mode\":\"test\",\"schema\":1.0}",
                "extra-field" => "{\"mode\":\"test\",\"schema\":1,\"futurePolicyField\":true}",
                _ => intent,
            }).Digest(change == "project" ? Guid.NewGuid() : project, change == "actor" ? Guid.NewGuid() : actor);
        await Assert.That(original.SequenceEqual(altered)).IsFalse();
    }

    [Test]
    public async Task PublicationRequest_StableAcrossCulturesAndCallerArrays()
    {
        var request = new PublicationRequest(Guid.NewGuid(), Project.MaxRevision, "{}");
        var project = Guid.NewGuid();
        var actor = Guid.NewGuid();
        var original = request.Digest(project, actor);
        var previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("ar-SA");
            await Assert.That(request.Digest(project, actor).SequenceEqual(original)).IsTrue();
        }
        finally { CultureInfo.CurrentCulture = previous; }
        original[0] ^= 1;
        await Assert.That(request.Digest(project, actor).SequenceEqual(original)).IsFalse();
    }

    [Test]
    [Arguments(-1L)]
    [Arguments(Project.MaxRevision + 1)]
    public void PublicationRequest_RejectsUnboundedRevision(long revision) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new PublicationRequest(Guid.NewGuid(), revision, "{}"));

    [Test]
    [Arguments("null")]
    [Arguments("[]")]
    [Arguments("true")]
    public void PublicationRequest_IntentMustBeObject(string intent) =>
        Assert.Throws<ArgumentException>(() => new PublicationRequest(Guid.NewGuid(), 0, intent));

    [Test]
    public void PublicationRequest_RejectsMissingIdOversizeDeepAndInvalidIntent()
    {
        Assert.Throws<ArgumentException>(() => new PublicationRequest(Guid.Empty, 0, "{}"));
        Assert.Throws<ArgumentNullException>(() => new PublicationRequest(Guid.NewGuid(), 0, null!));
        Assert.Throws<ArgumentException>(() => new PublicationRequest(Guid.NewGuid(), 0,
            "{\"text\":\"" + new string('é', PublicationRequest.MaxIntentBytes / 2) + "\"}"));
        Assert.Throws<JsonException>(() => new PublicationRequest(Guid.NewGuid(), 0, "{bad"));
        Assert.Throws<JsonException>(() => new PublicationRequest(Guid.NewGuid(), 0,
            "{\"nested\":" + new string('[', 16) + "0" + new string(']', 16) + "}"));
    }

    [Test]
    public async Task PublicationDocumentAssets_CollectsAllScenesModelsAndMediaCaseSensitively()
    {
        // The format fixture includes image/audio/video references removed by the development catalogue helper.
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m2-project.json"));
        var assets = new Dictionary<string, string>(StringComparer.Ordinal);
        using var parsed = JsonDocument.Parse(json);
        foreach (var scene in parsed.RootElement.GetProperty("scenes").EnumerateArray())
        {
            assets[scene.GetProperty("environmentAssetId").GetString()!] = "environment";
            foreach (var item in scene.GetProperty("objects").EnumerateArray())
            {
                assets[item.GetProperty("assetId").GetString()!] = "model";
                foreach (var component in item.GetProperty("components").EnumerateArray())
                {
                    if (component.TryGetProperty("assetId", out var id))
                    {
                        assets[id.GetString()!] = component.GetProperty("type").GetString()!;
                    }
                }
            }
        }
        var document = ProjectFormat.ProjectFormat.Deserialize(json, assets);
        await Assert.That(document.Ok).IsTrue();
        await Assert.That(PublicationDocumentAssets.Required(document.Value!).SetEquals(assets.Keys)).IsTrue();
        await Assert.That(assets.Values.ToHashSet().IsSupersetOf(["environment", "model", "image", "audio", "video"])).IsTrue();
    }
}
