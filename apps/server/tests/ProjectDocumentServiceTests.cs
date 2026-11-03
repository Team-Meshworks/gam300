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
        await Assert.That(development.Read(id, json.Replace("test-crate-v1", "demo-image-v1", StringComparison.Ordinal)).Ok).IsFalse();
        await Assert.That(development.Read(id, json.Replace("test-room-v1", "test-crate-v1", StringComparison.Ordinal)).Ok).IsFalse();
        await Assert.That(Create("Production").Read(id, json).Ok).IsFalse();
        await Assert.That(Create("Testing").Read(id, json).Ok).IsFalse();
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
    public async Task Documents_StoredValidationAllowsSavedContentAtTheSizeLimit()
    {
        var documents = Create("Development");
        var id = Guid.NewGuid();
        var input = JsonNode.Parse(ProjectTestDocuments.Create(id, "Saved snapshot"))!;
        // Match the writer's omitted empty extensions before padding the input to its byte limit.
        input["scenes"]![0]!.AsObject().Remove("hotspots");
        input["scenes"]![0]!.AsObject().Remove("interactions");
        input["scenes"]![0]!["startCamera"]!["rotation"] =
            new JsonArray(0.47490965438830257, -0.6980326014100272, -0.1736294030169948, -0.5070149287205405);
        var baseline = documents.Serialize(documents.Read(id, input.ToJsonString()).Value!).Value!;
        input["title"] = input["title"]!.GetValue<string>()
            + new string('x', Format.MaxProjectBytes - Encoding.UTF8.GetByteCount(baseline));
        var accepted = documents.Read(id, input.ToJsonString());
        await Assert.That(accepted.Ok).IsTrue();
        var saved = documents.Serialize(accepted.Value!);
        await Assert.That(saved.Ok).IsTrue();
        await Assert.That(Encoding.UTF8.GetByteCount(saved.Value!)).IsEqualTo(Format.MaxProjectBytes);
        await Assert.That(documents.ReadStored(id, 1, saved.Value!).Ok).IsTrue();
    }

    private static ProjectDocumentService Create(string environment) =>
        new(WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment }).Environment);
}
