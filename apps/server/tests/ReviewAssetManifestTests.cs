using System.Text.Json;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Spatia.ProjectFormat;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

public sealed class ReviewAssetManifestTests
{
    [Test]
    public async Task ReviewAssets_EmptySceneRequiresNoEnvironmentAsset()
    {
        var id = Guid.NewGuid();
        var documents = new ProjectDocumentService(new DevelopmentEnvironment());
        var result = documents.Read(id, ProjectTestDocuments.Create(id, "Review", 2));
        var project = (ContentProject)result.Value!;
        var scene = project.Scenes[0] with { EnvironmentAssetId = null, Objects = [], Audio = [] };
        var required = ReviewAssetManifest.Required(project with { Scenes = [scene] });
        await Assert.That(required).IsEmpty();
        await Assert.That(ReviewAssetManifest.Serialize(required, [])).IsEqualTo("[]");
    }

    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task ReviewAssets_ResolveEveryReferenceFromAValidatedDocument(int version)
    {
        var id = Guid.NewGuid();
        var documents = new ProjectDocumentService(new DevelopmentEnvironment());
        var document = documents.Read(id, ProjectTestDocuments.Create(id, "Review", version));
        await Assert.That(document.Ok).IsTrue();
        var required = ReviewAssetManifest.Required(document.Value!);
        await Assert.That(required.Contains("test-room-v1")).IsTrue();
        await Assert.That(required.Contains("test-crate-v1")).IsTrue();
        var resolved = required.Select(assetId => new ReviewAssetReference(assetId, new string('a', 64))).Reverse().ToArray();
        using var manifest = JsonDocument.Parse(ReviewAssetManifest.Serialize(required, resolved)!);
        var names = manifest.RootElement.EnumerateArray().Select(item => item.GetProperty("assetId").GetString()).ToArray();
        await Assert.That(names.SequenceEqual(names.Order(StringComparer.Ordinal))).IsTrue();
        await Assert.That(names.Length).IsEqualTo(required.Count);
    }

    [Test]
    public async Task ReviewAssets_IncludeMediaReferences()
    {
        var id = Guid.NewGuid();
        var documents = new ProjectDocumentService(new DevelopmentEnvironment());
        var result = documents.Read(id, ProjectTestDocuments.Create(id, "Review", 2));
        var project = (ContentProject)result.Value!;
        var scene = project.Scenes[0];
        var item = scene.Objects[0] with
        {
            Components = [new ImageComponent("image", "image-asset", "", ""),
                new AudioComponent("audio", "audio-asset", "", false, 1, AudioMode.Global),
                new VideoComponent("video", "video-asset", "", false, 1)],
        };
        var required = ReviewAssetManifest.Required(project with { Scenes = [scene with { Objects = [item] }] });
        await Assert.That(required.Contains("image-asset")).IsTrue();
        await Assert.That(required.Contains("audio-asset")).IsTrue();
        await Assert.That(required.Contains("video-asset")).IsTrue();
    }

    [Test]
    public async Task ReviewAssets_IncludeSceneAudioAndRequireItsResolvedIdentity()
    {
        var id = Guid.NewGuid();
        var documents = new ProjectDocumentService(new DevelopmentEnvironment());
        var result = documents.Read(id, ProjectTestDocuments.Create(id, "Review", 2));
        var project = (ContentProject)result.Value!;
        var scene = project.Scenes[0];
        var required = ReviewAssetManifest.Required(project with
        {
            Scenes = [scene with
            {
                Audio = [new AudioComponent("background", "scene-audio", "", true, 1, AudioMode.Global),
                    new AudioComponent("background-repeat", "scene-audio", "", false, 1, AudioMode.Global)],
            }],
        });

        await Assert.That(required.SetEquals([scene.EnvironmentAssetId ?? throw new InvalidOperationException("Fixture requires an environment"), scene.Objects[0].AssetId, "scene-audio"])).IsTrue();
        var resolved = required.Select(assetId => new ReviewAssetReference(assetId, new string('a', 64))).ToArray();
        await Assert.That(ReviewAssetManifest.Serialize(required, resolved.Where(row => row.AssetId != "scene-audio").ToArray())).IsNull();
        using var manifest = JsonDocument.Parse(ReviewAssetManifest.Serialize(required, resolved)!);
        await Assert.That(manifest.RootElement.EnumerateArray().Count(row => row.GetProperty("assetId").GetString() == "scene-audio")).IsEqualTo(1);
    }

    [Test]
    public async Task ReviewAssets_RejectMissingDuplicateUnexpectedAndInvalidReferences()
    {
        var required = new HashSet<string>(["room", "object"], StringComparer.Ordinal);
        var valid = new ReviewAssetReference("room", new string('a', 64));
        foreach (var references in new ReviewAssetReference[]?[]
        {
            null,
            [valid],
            [valid, valid],
            [valid, new("other", new string('b', 64))],
            [valid, new("object", new string('A', 64))],
            [valid, new("object", "bad")],
        })
        {
            await Assert.That(ReviewAssetManifest.Serialize(required, references)).IsNull();
        }
    }

    private sealed class DevelopmentEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "review-assets-test";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
