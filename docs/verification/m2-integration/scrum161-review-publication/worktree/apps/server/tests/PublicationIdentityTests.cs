using System.Text.Json.Nodes;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

public sealed class PublicationIdentityTests
{
    private static readonly Guid PublicationId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid ProjectId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid ActorId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly byte[] Digest = Enumerable.Repeat((byte)42, 32).ToArray();

    [Test]
    [Arguments(0L)]
    [Arguments(Project.MaxRevision)]
    public async Task PublicationIdentity_UnclaimedIdRequiresCreationEvenAtMaximumSourceRevision(long revision)
    {
        await Assert.That(PublicationRetryPolicy.Decide(null, PublicationId, ProjectId, ActorId, revision, Digest))
            .IsEqualTo(PublicationRetryDecision.CreateRequired);
    }

    [Test]
    [Arguments("same", PublicationRetryDecision.Replay)]
    [Arguments("project", PublicationRetryDecision.Conflict)]
    [Arguments("actor", PublicationRetryDecision.Conflict)]
    [Arguments("revision", PublicationRetryDecision.Conflict)]
    [Arguments("digest", PublicationRetryDecision.Conflict)]
    public async Task PublicationIdentity_ClaimedIdOnlyReplaysItsExactOriginalRequest(string change, PublicationRetryDecision expected)
    {
        var digest = Digest.ToArray();
        if (change == "digest")
        {
            digest[^1] ^= 1;
        }

        var result = PublicationRetryPolicy.Decide(Existing(), PublicationId,
            change == "project" ? Guid.NewGuid() : ProjectId,
            change == "actor" ? Guid.NewGuid() : ActorId, change == "revision" ? 13 : 12, digest);

        await Assert.That(result).IsEqualTo(expected);
    }

    [Test]
    [Arguments(-1L)]
    [Arguments(Project.MaxRevision + 1)]
    public void PublicationIdentity_UnboundedRevisionIsRejected(long revision) =>
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PublicationRetryPolicy.Decide(null, PublicationId, ProjectId, ActorId, revision, Digest));

    [Test]
    [Arguments(0)]
    [Arguments(31)]
    [Arguments(33)]
    public void PublicationIdentity_InvalidRequestDigestIsRejected(int length) =>
        Assert.Throws<ArgumentException>(() =>
            PublicationRetryPolicy.Decide(null, PublicationId, ProjectId, ActorId, 12, new byte[length]));

    [Test]
    [Arguments("publication")]
    [Arguments("project")]
    [Arguments("actor")]
    public void PublicationIdentity_EmptyIdentifiersAreRejected(string field) =>
        Assert.Throws<ArgumentException>(() => PublicationRetryPolicy.Decide(null,
            field == "publication" ? Guid.Empty : PublicationId,
            field == "project" ? Guid.Empty : ProjectId,
            field == "actor" ? Guid.Empty : ActorId, 12, Digest));

    [Test]
    public void PublicationIdentity_RowFromAnotherLookupIsNotTreatedAsAnUnclaimedId() =>
        Assert.Throws<ArgumentException>(() =>
            PublicationRetryPolicy.Decide(Existing(), Guid.NewGuid(), ProjectId, ActorId, 12, Digest));

    [Test]
    [Arguments(0)]
    [Arguments(31)]
    [Arguments(33)]
    public void PublicationIdentity_CorruptPersistedDigestIsRejected(int length) =>
        Assert.Throws<ArgumentException>(() =>
            PublicationRetryPolicy.Decide(Existing(new byte[length]), PublicationId, ProjectId, ActorId, 12, Digest));

    [Test]
    public async Task PublicationManifest_NormalizesHashAndOrderButPreservesExactAssetIds()
    {
        var first = new PublicationAssetReference("Room-v1", new string('A', 64));
        var second = new PublicationAssetReference("room-v1", new string('b', 64));
        var json = PublicationAssetManifest.Serialize([second, first]);

        await Assert.That(json).IsEqualTo(PublicationAssetManifest.Serialize([first, second]));
        var parsed = JsonNode.Parse(json)!.AsArray();
        await Assert.That(parsed.Count).IsEqualTo(2);
        await Assert.That(parsed[0]!["assetId"]!.GetValue<string>()).IsEqualTo("Room-v1");
        await Assert.That(parsed[0]!["sha256"]!.GetValue<string>()).IsEqualTo(new string('a', 64));
        await Assert.That(parsed[1]!["assetId"]!.GetValue<string>()).IsEqualTo("room-v1");
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public void PublicationManifest_DuplicateAssetIdIsRejectedEvenWhenHashesAgree(bool changedHash)
    {
        var first = new PublicationAssetReference("room-v1", new string('a', 64));
        var second = new PublicationAssetReference("room-v1", new string(changedHash ? 'b' : 'a', 64));

        Assert.Throws<ArgumentException>(() => PublicationAssetManifest.Serialize([first, second]));
    }

    [Test]
    [Arguments("")]
    [Arguments(" ")]
    [Arguments("\t\r\n")]
    public void PublicationManifest_BlankAssetIdsAreRejected(string id) =>
        Assert.Throws<ArgumentException>(() => new PublicationAssetReference(id, new string('a', 64)));

    [Test]
    [Arguments("")]
    [Arguments("sha256:abc")]
    [Arguments("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [Arguments("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaag")]
    [Arguments("gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg")]
    public void PublicationManifest_InvalidContentHashesAreRejected(string hash) =>
        Assert.Throws<ArgumentException>(() => new PublicationAssetReference("room-v1", hash));

    [Test]
    public void PublicationManifest_NullInputsAreRejected()
    {
        Assert.Throws<ArgumentNullException>(() => new PublicationAssetReference(null!, new string('a', 64)));
        Assert.Throws<ArgumentNullException>(() => new PublicationAssetReference("room-v1", null!));
        Assert.Throws<ArgumentNullException>(() => PublicationAssetManifest.Serialize(null!));
        Assert.Throws<ArgumentNullException>(() => PublicationAssetManifest.Serialize([null!]));
    }

    private static Publication Existing(byte[]? digest = null) => new()
    {
        Id = PublicationId,
        ProjectId = ProjectId,
        PublishedById = ActorId,
        SourceRevision = 12,
        SchemaVersion = 1,
        DocumentJson = "{}",
        AssetReferencesJson = "[]",
        RequestDigest = digest ?? Digest.ToArray(),
    };
}
