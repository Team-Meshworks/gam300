using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Spatia.ProjectFormat;
using Spatia.Server.Projects;
using Format = Spatia.ProjectFormat.ProjectFormat;

namespace Spatia.Server.Tests;

public sealed class ProjectDocumentServiceTests
{
    [Test]
    public async Task Documents_UseOnlyThePackagedDevelopmentCatalogue()
    {
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m1-project.json"));
        var id = Guid.Parse(JsonNode.Parse(json)!["projectId"]!.GetValue<string>());
        var development = Create("Development");
        await Assert.That(development.Read(id, json).Ok).IsTrue();
        await Assert.That(development.Read(id, json.Replace("test-crate-v1", "sample-snowglobe-v1", StringComparison.Ordinal)).Ok).IsTrue();
        foreach (var standId in new[] { "display-cube-v1", "display-full-glass-case-v1", "display-half-glass-case-v1",
            "display-one-sided-glass-case-v1", "display-rectangle-stand-v1", "display-rectangle-panel-v1", "display-square-stand-v1", "display-square-panel-v1" })
        {
            await Assert.That(development.Read(id, json.Replace("test-crate-v1", standId, StringComparison.Ordinal)).Ok).IsTrue();
        }

        await Assert.That(development.Read(id, json.Replace("test-crate-v1", "test-room-module-v1", StringComparison.Ordinal)).Ok).IsTrue();
        await Assert.That(development.Read(id, json.Replace("test-crate-v1", "demo-image-v1", StringComparison.Ordinal)).Ok).IsFalse();
        await Assert.That(development.Read(id, json.Replace("test-room-v1", "test-crate-v1", StringComparison.Ordinal)).Ok).IsFalse();
        foreach (var asset in new[] { "display-square-stand-v1", "display-cube-v1" })
        {
            var fixture = json.Replace("test-crate-v1", asset, StringComparison.Ordinal);
            await Assert.That(development.Read(id, fixture).Ok).IsTrue();
            await Assert.That(Create("Production").Read(id, fixture).Ok).IsFalse();
        }
        await Assert.That(Create("Production").Read(id, json).Ok).IsFalse();
        await Assert.That(Create("Testing").Read(id, json).Ok).IsFalse();
    }

    [Test]
    [Arguments("furniture-modern-bench-1-v1")]
    [Arguments("furniture-modern-bench-2-v1")]
    public async Task Documents_PackagedBenchModelsRoundTripOnlyInDevelopment(string assetId)
    {
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m1-project.json"))
            .Replace("test-crate-v1", assetId, StringComparison.Ordinal);
        var id = Guid.Parse(JsonNode.Parse(json)!["projectId"]!.GetValue<string>());
        var development = Create("Development");
        var document = development.Read(id, json);
        await Assert.That(document.Ok).IsTrue();
        var saved = development.Serialize(document.Value!);
        await Assert.That(saved.Ok).IsTrue();
        await Assert.That(development.Read(id, saved.Value!).Ok).IsTrue();
        await Assert.That(Create("Production").Read(id, json).Ok).IsFalse();
    }

    [Test]
    [Arguments("model", "library-untitled-v1")]
    [Arguments("environment", "room-space1-v1")]
    [Arguments("environment", "room-doors-1-v1")]
    [Arguments("environment", "room-doors-2-v1")]
    [Arguments("environment", "room-doors-3-v1")]
    [Arguments("environment", "room-doors-4-v1")]
    [Arguments("environment", "room-doors-1-2-v1")]
    [Arguments("environment", "room-doors-1-3-v1")]
    [Arguments("environment", "room-doors-1-4-v1")]
    [Arguments("environment", "room-doors-2-3-v1")]
    [Arguments("environment", "room-doors-2-4-v1")]
    [Arguments("environment", "room-doors-3-4-v1")]
    [Arguments("environment", "room-doors-1-2-3-v1")]
    [Arguments("environment", "room-doors-1-2-4-v1")]
    [Arguments("environment", "room-doors-1-3-4-v1")]
    [Arguments("environment", "room-doors-2-3-4-v1")]
    [Arguments("environment", "room-doors-1-2-3-4-v1")]
    public async Task Documents_NewPackagedAssetsRoundTripOnlyInDevelopment(string kind, string assetId)
    {
        var fixture = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m1-project.json"));
        var json = fixture.Replace(kind == "environment" ? "test-room-v1" : "test-crate-v1", assetId, StringComparison.Ordinal);
        var id = Guid.Parse(JsonNode.Parse(json)!["projectId"]!.GetValue<string>());
        var development = Create("Development");
        var document = development.Read(id, json);
        await Assert.That(document.Ok).IsTrue();
        var saved = development.Serialize(document.Value!);
        await Assert.That(saved.Ok).IsTrue();
        await Assert.That(development.Read(id, saved.Value!).Ok).IsTrue();
        await Assert.That(development.ReadStored(id, 1, saved.Value!).Ok).IsTrue();
        var wrongKind = fixture.Replace(kind == "environment" ? "test-crate-v1" : "test-room-v1", assetId, StringComparison.Ordinal);
        await Assert.That(development.Read(id, wrongKind).Ok).IsFalse();
        await Assert.That(Create("Production").Read(id, json).Ok).IsFalse();
    }

    [Test]
    [Arguments("image", "sample-landscape-image-v1")]
    [Arguments("image", "sample-coast-image-v1")]
    [Arguments("video", "sample-coast-video-v1")]
    [Arguments("image", "sample-dunes-image-v1")]
    [Arguments("image", "sample-forest-image-v1")]
    [Arguments("image", "sample-sunset-image-v1")]
    [Arguments("image", "sample-valley-image-v1")]
    [Arguments("video", "sample-dunes-video-v1")]
    [Arguments("video", "sample-forest-video-v1")]
    [Arguments("video", "sample-sunset-video-v1")]
    public async Task Documents_SampleMediaRoundTripsOnlyInDevelopment(string kind, string assetId)
    {
        var id = Guid.NewGuid();
        var input = JsonNode.Parse(ProjectTestDocuments.Create(id, "Sample media", 2))!;
        var components = input["scenes"]![0]!["objects"]![0]!["components"]!.AsArray();
        components.Add(new JsonObject
        {
            ["id"] = Guid.NewGuid().ToString("D"),
            ["type"] = kind,
            ["assetId"] = assetId,
            ["caption"] = "Sample caption",
        });
        var component = components.Last()!;
        if (kind == "image") { component["alt"] = "Sample landscape"; }
        else { component["loop"] = false; component["volume"] = 1; }
        var development = Create("Development");
        var accepted = development.Read(id, input.ToJsonString());
        await Assert.That(accepted.Ok).IsTrue();
        var saved = development.Serialize(accepted.Value!);
        await Assert.That(saved.Ok).IsTrue();
        await Assert.That(development.Read(id, saved.Value!).Ok).IsTrue();
        await Assert.That(Create("Production").Read(id, input.ToJsonString()).Ok).IsFalse();
    }

    [Test]
    public async Task Documents_StoredContentStillRequiresMatchingMetadataAndCompleteValidation()
    {
        var documents = Create("Development");
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m1-project.json"));
        var id = Guid.Parse(JsonNode.Parse(json)!["projectId"]!.GetValue<string>());
        await Assert.That(documents.ReadStored(id, 1, json).Ok).IsTrue();
        await Assert.That(documents.ReadStored(Guid.NewGuid(), 1, json).Ok).IsFalse();
        await Assert.That(documents.ReadStored(id, 2, json).Ok).IsFalse();
        await Assert.That(documents.ReadStored(id, 1, "{").Ok).IsFalse();
        await Assert.That(documents.ReadStored(id, 1, json.Replace("test-room-v1", "missing", StringComparison.Ordinal)).Ok).IsFalse();
        var node = JsonNode.Parse(json)!;
        node["title"] = new string('x', Spatia.ProjectFormat.ProjectFormat.MaxProjectBytes);
        await Assert.That(documents.ReadStored(id, 1, node.ToJsonString()).Ok).IsFalse();
    }

    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task Documents_StoredValidationPreservesSavedRotations(int version)
    {
        var documents = Create("Development");
        var id = Guid.NewGuid();
        var input = JsonNode.Parse(ProjectTestDocuments.Create(id, "Saved rotation", version))!;
        input["scenes"]![0]!["startCamera"]!["rotation"] = new JsonArray(
            -0.04334603238835914, -0.4929046071223118, 0.7105726134622642, 0.5002526669106266);
        var accepted = documents.Read(id, input.ToJsonString());
        await Assert.That(accepted.Ok).IsTrue();
        var saved = documents.Serialize(accepted.Value!);
        await Assert.That(saved.Ok).IsTrue();
        var expected = JsonNode.Parse(saved.Value!)!["scenes"]![0]!["startCamera"]!["rotation"]!
            .AsArray().Select(value => value!.GetValue<double>()).ToArray();
        var stored = documents.ReadStored(id, version, saved.Value!);
        await Assert.That(stored.Ok).IsTrue();
        var actual = stored.Value is LegacyProject legacy
            ? legacy.Scenes[0].StartCamera.Rotation : ((ContentProject)stored.Value!).Scenes[0].StartCamera.Rotation;
        await Assert.That(actual.SequenceEqual(expected)).IsTrue();
    }

    [Test]
    [Arguments("read-limit")]
    [Arguments("serialize-limit")]
    [Arguments("jsonb-scale")]
    public async Task Documents_StoredValidationAllowsSavedContentAtTheSizeLimit(string scenario)
    {
        var documents = Create("Development");
        var id = Guid.NewGuid();
        var input = JsonNode.Parse(ProjectTestDocuments.Create(id, "Saved snapshot"))!;
        input["scenes"]![0]!["startCamera"]!["rotation"] = scenario switch
        {
            "read-limit" => new JsonArray(0.47490965438830257, -0.6980326014100272, -0.1736294030169948, -0.5070149287205405),
            "serialize-limit" => new JsonArray(0.6267845488506097, -0.36662911366558604, 0.5535539462274982, -0.4078017299508285),
            _ => new JsonArray(0, 0, 0, 1),
        };
        if (scenario == "jsonb-scale")
        {
            input["scenes"]![0]!["objects"]![0]!["transform"]!["scale"] = new JsonArray(double.MaxValue, double.Epsilon, 1);
        }
        ProjectTestDocuments.PadTitleToBytes(input, Format.MaxProjectBytes);
        await Assert.That(Encoding.UTF8.GetByteCount(input.ToJsonString())).IsEqualTo(Format.MaxProjectBytes);
        var accepted = documents.Read(id, input.ToJsonString());
        await Assert.That(accepted.Ok).IsTrue();
        var saved = documents.Serialize(accepted.Value!);
        await Assert.That(saved.Ok).IsTrue();
        await Assert.That(Encoding.UTF8.GetByteCount(saved.Value!)).IsEqualTo(Format.MaxProjectBytes);
        await Assert.That(documents.ReadStored(id, 1, saved.Value!).Ok).IsTrue();
    }

    [Test]
    [Arguments(1, false)]
    [Arguments(2, false)]
    [Arguments(1, true)]
    [Arguments(2, true)]
    public async Task Documents_OmitOnlyEmptyInteractionExtensions(int version, bool authored)
    {
        var documents = Create("Development");
        var id = Guid.NewGuid();
        var input = JsonNode.Parse(ProjectTestDocuments.Create(id, "Interaction export", version))!;
        var scene = input["scenes"]![0]!;
        var hotspotId = Guid.NewGuid().ToString("D");
        scene["hotspots"] = authored ? new JsonArray(new JsonObject
        {
            ["id"] = hotspotId,
            ["objectId"] = scene["objects"]![0]!["id"]!.GetValue<string>(),
            ["position"] = new JsonArray(0, 0, 0),
        }) : new JsonArray();
        scene["interactions"] = authored ? new JsonArray(new JsonObject
        {
            ["when"] = new JsonObject { ["type"] = "visitor-clicks-hotspot", ["targetHotspotId"] = hotspotId },
            ["do"] = new JsonObject { ["type"] = "print-hi" },
        }) : new JsonArray();
        var accepted = documents.Read(id, input.ToJsonString());
        await Assert.That(accepted.Ok).IsTrue();
        var saved = documents.Serialize(accepted.Value!);
        await Assert.That(saved.Ok).IsTrue();
        var exported = JsonNode.Parse(saved.Value!)!["scenes"]![0]!;
        foreach (var name in new[] { "hotspots", "interactions" })
        {
            await Assert.That(exported.AsObject().ContainsKey(name)).IsEqualTo(authored);
            if (authored) { await Assert.That(JsonNode.DeepEquals(scene[name], exported[name])).IsTrue(); }
        }
        var reopened = documents.ReadStored(id, version, saved.Value!);
        await Assert.That(reopened.Ok).IsTrue();
        var count = reopened.Value is LegacyProject legacy ? legacy.Scenes[0].Hotspots.Length
            : ((ContentProject)reopened.Value!).Scenes[0].Hotspots.Length;
        await Assert.That(count).IsEqualTo(authored ? 1 : 0);
    }

    [Test]
    public async Task Documents_PreserveSceneAudioFromTheDevelopmentCatalogue()
    {
        var document = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m1-project.json")))!;
        document["schemaVersion"] = 2;
        var scene = document["scenes"]![0]!;
        foreach (var field in new[] { "groups", "zones", "viewpoints", "rules" }) { scene[field] = new JsonArray(); }
        foreach (var item in scene["objects"]!.AsArray())
        {
            item!["parentId"] = null;
            item["visible"] = true;
            item["components"] = new JsonArray();
        }
        // Save root audio through the same development catalogue boundary used by the API
        scene["audio"] = new JsonArray(new JsonObject
        {
            ["id"] = Guid.NewGuid().ToString(),
            ["type"] = "audio",
            ["mode"] = "global",
            ["assetId"] = "audio-ethereal-calm-v1",
            ["caption"] = "",
            ["loop"] = true,
            ["volume"] = 1,
        });
        var id = Guid.Parse(document["projectId"]!.GetValue<string>());
        var service = Create("Development");
        var accepted = service.Read(id, document.ToJsonString());
        await Assert.That(accepted.Ok).IsTrue();
        var saved = service.Serialize(accepted.Value!);
        await Assert.That(saved.Ok).IsTrue();
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(saved.Value!)!["scenes"]![0]!["audio"], scene["audio"])).IsTrue();
        // Development-only media must still be rejected by the production reader
        await Assert.That(Create("Production").Read(id, document.ToJsonString()).Ok).IsFalse();
    }

    private static ProjectDocumentService Create(string environment) =>
        new(WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment }).Environment);
}
