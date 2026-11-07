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
    public async Task PublicationV2_TwoSceneRoundTripPreservesAuthoredDataAndCapabilityDecisions()
    {
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m2-publication-project.json"));
        var parsed = Format.Deserialize(json, Assets);
        await Assert.That(parsed.Ok).IsTrue();
        var project = (ContentProject)parsed.Value!;
        await Assert.That(project.Scenes.Length).IsEqualTo(2);
        await Assert.That(ProjectCapabilities.Missing(project, PublicationCapabilities.Supported).Count).IsEqualTo(0);
        var saved = Format.Serialize(project, Assets);
        await Assert.That(saved.Ok).IsTrue();
        var reopened = Format.Deserialize(saved.Value!, Assets);
        await Assert.That(reopened.Ok).IsTrue();
        var secondSave = Format.Serialize(reopened.Value!, Assets);
        await Assert.That(secondSave.Value).IsEqualTo(saved.Value);
        var original = JsonNode.Parse(json)!;
        var output = JsonNode.Parse(saved.Value!)!;
        foreach (var field in new[] { "objects", "groups", "zones", "viewpoints", "rules" })
        {
            for (var scene = 0; scene < 2; scene++)
            {
                await Assert.That(JsonNode.DeepEquals(original["scenes"]![scene]![field], output["scenes"]![scene]![field])).IsTrue();
            }
        }
        original["scenes"]![0]!["rules"]![0]!["enabled"] = true;
        var enabled = Format.Deserialize(original.ToJsonString(), Assets);
        await Assert.That(enabled.Ok).IsTrue();
        var missing = ProjectCapabilities.Missing(enabled.Value!, PublicationCapabilities.Supported);
        await Assert.That(missing.Any(issue => issue.Capability == "trigger:sceneStart" && issue.Path == "project.scenes[0].rules[0].trigger")).IsTrue();
        await Assert.That(missing.Any(issue => issue.Capability == "action:showPanel")).IsTrue();
        await Assert.That(Format.Serialize(enabled.Value!, Assets).Ok).IsTrue();
    }

    [Test]
    public async Task PublicationV2_GlobalAudioRemainsAnImmutableRequiredReferenceEvenWhileUnsupported()
    {
        var input = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m2-publication-project.json")))!;
        input["scenes"]![0]!["audio"] = JsonNode.Parse("""[{"id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","type":"audio","mode":"global","assetId":"demo-audio-v1","caption":"Ambient sound","loop":true,"volume":0.5}]""");
        var parsed = Format.Deserialize(input.ToJsonString(), Assets);
        await Assert.That(parsed.Ok).IsTrue();
        await Assert.That(PublicationDocumentAssets.Required(parsed.Value!).Contains("demo-audio-v1")).IsTrue();
        await Assert.That(ProjectCapabilities.Missing(parsed.Value!, PublicationCapabilities.Supported).Any(issue => issue.Capability == "audio:global")).IsTrue();
    }
}
