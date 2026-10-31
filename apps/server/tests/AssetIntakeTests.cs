using Microsoft.Extensions.Configuration;
using Spatia.Server.Assets;

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
