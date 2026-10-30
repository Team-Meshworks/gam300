using System.Collections.Immutable;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

public sealed class ProjectSavePolicyTests
{
    private const long RevisionLimit = 9_007_199_254_740_991;
    private static readonly Guid ActorId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid OtherActorId = Guid.Parse("66666666-6666-4666-8666-666666666666");
    private static readonly Guid MutationId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid OtherMutationId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly ImmutableArray<byte> Digest = ImmutableArray.CreateRange(Enumerable.Repeat((byte)42, 32));

    [Test]
    [Arguments(0L, 0L, ProjectSaveDecision.WriteRequired)]
    [Arguments(12L, 11L, ProjectSaveDecision.Conflict)]
    [Arguments(12L, 13L, ProjectSaveDecision.Conflict)]
    [Arguments(RevisionLimit - 1, RevisionLimit - 1, ProjectSaveDecision.WriteRequired)]
    [Arguments(RevisionLimit, RevisionLimit, ProjectSaveDecision.RevisionExhausted)]
    public async Task SavePolicy_NewMutationRequiresCurrentRevisionBelowLimit(
        long revision, long expectedRevision, ProjectSaveDecision expected)
    {
        var decision = ProjectSavePolicy.Decide(Snapshot(revision), expectedRevision, MutationId, Digest.AsSpan());

        await Assert.That(decision).IsEqualTo(expected);
    }

    [Test]
    [Arguments("identical", ProjectSaveDecision.Replay)]
    [Arguments("changed-digest", ProjectSaveDecision.Conflict)]
    [Arguments("changed-actor", ProjectSaveDecision.Conflict)]
    [Arguments("changed-original-revision", ProjectSaveDecision.Conflict)]
    public async Task SavePolicy_LatestMutationReplaysOnlyTheSameRequest(string change, ProjectSaveDecision expected)
    {
        var snapshot = SavedSnapshot();
        var requestDigest = Digest.ToArray();
        var expectedRevision = 11L;
        switch (change)
        {
            case "changed-digest": requestDigest[0] ^= 1; break;
            case "changed-actor": snapshot = snapshot with { ActorId = OtherActorId }; break;
            case "changed-original-revision": expectedRevision = 12; break;
        }

        var decision = ProjectSavePolicy.Decide(snapshot, expectedRevision, MutationId, requestDigest);

        await Assert.That(decision).IsEqualTo(expected);
    }

    [Test]
    public async Task SavePolicy_NewMutationWithIdenticalContentRequiresAnotherWrite()
    {
        var decision = ProjectSavePolicy.Decide(SavedSnapshot(), 12, OtherMutationId, Digest.AsSpan());

        await Assert.That(decision).IsEqualTo(ProjectSaveDecision.WriteRequired);
    }

    [Test]
    public async Task SavePolicy_OlderRetryAfterANewerSaveConflicts()
    {
        var newer = SavedSnapshot(13) with { LastMutationId = OtherMutationId };

        var decision = ProjectSavePolicy.Decide(newer, 11, MutationId, Digest.AsSpan());

        await Assert.That(decision).IsEqualTo(ProjectSaveDecision.Conflict);
    }

    [Test]
    public async Task SavePolicy_ExactLatestRetryAtRevisionLimitStillReplays()
    {
        var decision = ProjectSavePolicy.Decide(SavedSnapshot(RevisionLimit), RevisionLimit - 1,
            MutationId, Digest.AsSpan());

        await Assert.That(decision).IsEqualTo(ProjectSaveDecision.Replay);
    }

    [Test]
    [Arguments(-1L)]
    [Arguments(RevisionLimit + 1)]
    public void SavePolicy_InvalidExpectedRevisionIsRejected(long expectedRevision)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            ProjectSavePolicy.Decide(Snapshot(12), expectedRevision, MutationId, Digest.AsSpan()));
    }

    [Test]
    [Arguments(0)]
    [Arguments(31)]
    [Arguments(33)]
    public void SavePolicy_RequestDigestMustHaveTheStoredLength(int length)
    {
        Assert.Throws<ArgumentException>(() =>
            ProjectSavePolicy.Decide(Snapshot(12), 12, MutationId, new byte[length]));
    }

    [Test]
    public void SavePolicy_NullSnapshotIsRejected()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ProjectSavePolicy.Decide(null!, 12, MutationId, Digest.AsSpan()));
    }

    [Test]
    [Arguments("negative-revision")]
    [Arguments("excessive-revision")]
    [Arguments("archived")]
    [Arguments("not-editable")]
    public void SavePolicy_NonEditableOrUnboundedSnapshotIsRejected(string problem)
    {
        var snapshot = problem switch
        {
            "negative-revision" => Snapshot(-1),
            "excessive-revision" => Snapshot(RevisionLimit + 1),
            "archived" => Snapshot(12) with { IsArchived = true },
            "not-editable" => Snapshot(12) with { CanEdit = false },
            _ => throw new ArgumentOutOfRangeException(nameof(problem)),
        };

        Assert.Throws<ArgumentException>(() =>
            ProjectSavePolicy.Decide(snapshot, 12, MutationId, Digest.AsSpan()));
    }

    [Test]
    [Arguments("missing-actor")]
    [Arguments("missing-id")]
    [Arguments("missing-digest")]
    [Arguments("default-digest")]
    [Arguments("short-digest")]
    public void SavePolicy_IncompleteOrMalformedStoredMutationIsRejected(string problem)
    {
        var snapshot = problem switch
        {
            "missing-actor" => SavedSnapshot() with { LastMutationActorId = null },
            "missing-id" => SavedSnapshot() with { LastMutationId = null },
            "missing-digest" => SavedSnapshot() with { LastMutationDigest = null },
            "default-digest" => SavedSnapshot() with { LastMutationDigest = default(ImmutableArray<byte>) },
            "short-digest" => SavedSnapshot() with { LastMutationDigest = ImmutableArray.Create((byte)42) },
            _ => throw new ArgumentOutOfRangeException(nameof(problem)),
        };

        Assert.Throws<ArgumentException>(() =>
            ProjectSavePolicy.Decide(snapshot, 11, MutationId, Digest.AsSpan()));
    }

    private static ProjectAccessSnapshot SavedSnapshot(long revision = 12) => Snapshot(revision) with
    {
        LastMutationActorId = ActorId,
        LastMutationId = MutationId,
        LastMutationDigest = Digest,
    };

    private static ProjectAccessSnapshot Snapshot(long revision) => new(
        ActorId, Guid.Parse("44444444-4444-4444-8444-444444444444"),
        Guid.Parse("55555555-5555-4555-8555-555555555555"),
        IsArchived: false, revision, SchemaVersion: 1, UnvalidatedDocumentJson: "{}",
        UpdatedAt: DateTimeOffset.UnixEpoch, LastMutationActorId: null, LastMutationId: null,
        LastMutationDigest: null, CanEdit: true, CanManage: false, CanPublish: false);
}
