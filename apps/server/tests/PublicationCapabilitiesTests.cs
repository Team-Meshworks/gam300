using System.Text.Json.Nodes;
using Spatia.ProjectFormat;
using Spatia.Server.Publications;
using Format = Spatia.ProjectFormat.ProjectFormat;

namespace Spatia.Server.Tests;

public sealed class PublicationCapabilitiesTests
{
    private static readonly Dictionary<string, string> Assets = new()
    {
        ["test-room-v1"] = "environment",
        ["test-crate-v1"] = "model",
        ["demo-image-v1"] = "image",
        ["demo-audio-v1"] = "audio",
        ["demo-video-v1"] = "video",
    };

    [Test]
    public async Task PublicationV2_SupportsBothScenesAndEnabledRules()
    {
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m2-publication-project.json"));
        var parsed = Format.Deserialize(json, Assets);
        await Assert.That(parsed.Ok).IsTrue();
        var project = (ContentProject)parsed.Value!;
        await Assert.That(project.Scenes.Length).IsEqualTo(2);
        await Assert.That(ProjectCapabilities.Missing(project, PublicationCapabilities.Supported).Count).IsEqualTo(0);
        var original = JsonNode.Parse(json)!;
        original["scenes"]![0]!["rules"]![0]!["enabled"] = true;
        var enabled = Format.Deserialize(original.ToJsonString(), Assets);
        await Assert.That(enabled.Ok).IsTrue();
        var missing = ProjectCapabilities.Missing(enabled.Value!, PublicationCapabilities.Supported);
        await Assert.That(missing.Count).IsEqualTo(0);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationAssets_RetainsPlayableSceneAudioWithOrWithoutAnEnvironment(bool hasEnvironment)
    {
        var input = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m2-publication-project.json")))!;
        if (!hasEnvironment) { input["scenes"]![0]!["environmentAssetId"] = null; }
        input["scenes"]![0]!["audio"] = JsonNode.Parse("""[{"id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","type":"audio","mode":"global","assetId":"demo-audio-v1","caption":"Ambient sound","loop":true,"volume":0.5}]""");
        var parsed = Format.Deserialize(input.ToJsonString(), Assets);
        await Assert.That(parsed.Ok).IsTrue();
        var required = PublicationDocumentAssets.Required(parsed.Value!);
        await Assert.That(required.Contains("demo-audio-v1")).IsTrue();
        await Assert.That(required.Contains(null!)).IsFalse();
        await Assert.That(ProjectCapabilities.Missing(parsed.Value!, PublicationCapabilities.Supported).Count).IsEqualTo(0);
    }
}
