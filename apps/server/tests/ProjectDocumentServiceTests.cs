using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Spatia.Server.Projects;

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
        var rooms = json.Replace("test-crate-v1", "test-room-module-v1", StringComparison.Ordinal);
        await Assert.That(development.Read(id, rooms).Ok).IsTrue();
        await Assert.That(Create("Production").Read(id, rooms).Ok).IsFalse();
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

    private static ProjectDocumentService Create(string environment) =>
        new(WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment }).Environment);
}
