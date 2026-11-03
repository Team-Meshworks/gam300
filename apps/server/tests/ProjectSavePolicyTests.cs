using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

public sealed class ProjectSavePolicyTests
{
    private const long RevisionLimit = 9_007_199_254_740_991;
    private static readonly Guid ActorId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid OtherActorId = Guid.Parse("66666666-6666-4666-8666-666666666666");
    private static readonly Guid MutationId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid OtherMutationId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly byte[] Digest = Enumerable.Repeat((byte)42, 32).ToArray();

    [Test]
    [Arguments(0L, 0L, ProjectSaveDecision.WriteRequired)]
    [Arguments(12L, 11L, ProjectSaveDecision.Conflict)]
    [Arguments(12L, 13L, ProjectSaveDecision.Conflict)]
    [Arguments(RevisionLimit - 1, RevisionLimit - 1, ProjectSaveDecision.WriteRequired)]
    [Arguments(RevisionLimit, RevisionLimit, ProjectSaveDecision.RevisionExhausted)]
    public async Task SavePolicy_NewMutationRequiresCurrentRevisionBelowLimit(
        long revision, long expectedRevision, ProjectSaveDecision expected)
    {
        var decision = ProjectSavePolicy.Decide(Snapshot(revision), expectedRevision, MutationId, Digest, null);

        await Assert.That(decision).IsEqualTo(expected);
    }

    [Test]
    [Arguments("identical", ProjectSaveDecision.Replay)]
    [Arguments("changed-digest", ProjectSaveDecision.Conflict)]
    [Arguments("changed-actor", ProjectSaveDecision.Conflict)]
    [Arguments("changed-original-revision", ProjectSaveDecision.Conflict)]
    public async Task SavePolicy_ReceiptReplaysOnlyTheSameRequest(string change, ProjectSaveDecision expected)
    {
        var snapshot = Snapshot(12);
        var requestDigest = Digest.ToArray();
        var expectedRevision = 11L;
        switch (change)
        {
            case "changed-digest": requestDigest[0] ^= 1; break;
            case "changed-actor": snapshot = snapshot with { ActorId = OtherActorId }; break;
            case "changed-original-revision": expectedRevision = 12; break;
        }

        var decision = ProjectSavePolicy.Decide(snapshot, expectedRevision, MutationId, requestDigest, Receipt());

        await Assert.That(decision).IsEqualTo(expected);
    }

    [Test]
    public async Task SavePolicy_NewMutationWithIdenticalContentRequiresAnotherWrite()
    {
        var decision = ProjectSavePolicy.Decide(Snapshot(12), 12, OtherMutationId, Digest, null);

        await Assert.That(decision).IsEqualTo(ProjectSaveDecision.WriteRequired);
    }

    [Test]
    [Arguments(13L)]
    [Arguments(RevisionLimit)]
    public async Task SavePolicy_HistoricalReceiptReplaysAfterLaterRevisions(long revision)
    {
        var decision = ProjectSavePolicy.Decide(Snapshot(revision), 11, MutationId, Digest, Receipt());

        await Assert.That(decision).IsEqualTo(ProjectSaveDecision.Replay);
    }

    [Test]
    public async Task SavePolicy_ExactLatestRetryAtRevisionLimitStillReplays()
    {
        var decision = ProjectSavePolicy.Decide(Snapshot(RevisionLimit), RevisionLimit - 1,
            MutationId, Digest, Receipt(RevisionLimit));

        await Assert.That(decision).IsEqualTo(ProjectSaveDecision.Replay);
    }

    [Test]
    [Arguments(-1L)]
    [Arguments(RevisionLimit + 1)]
    public void SavePolicy_InvalidExpectedRevisionIsRejected(long expectedRevision)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            ProjectSavePolicy.Decide(Snapshot(12), expectedRevision, MutationId, Digest, null));
    }

    [Test]
    [Arguments(0)]
    [Arguments(31)]
    [Arguments(33)]
    public void SavePolicy_RequestDigestMustHaveTheStoredLength(int length)
    {
        Assert.Throws<ArgumentException>(() =>
            ProjectSavePolicy.Decide(Snapshot(12), 12, MutationId, new byte[length], null));
    }

    [Test]
    public void SavePolicy_NullSnapshotIsRejected()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ProjectSavePolicy.Decide(null!, 12, MutationId, Digest, null));
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
            ProjectSavePolicy.Decide(snapshot, 12, MutationId, Digest, null));
    }

    [Test]
    [Arguments("wrong-project")]
    [Arguments("wrong-mutation")]
    [Arguments("missing-digest")]
    [Arguments("short-digest")]
    public void SavePolicy_ReceiptMustMatchLookupIdentityAndDigestLength(string problem)
    {
        var receipt = Receipt();
        switch (problem)
        {
            case "wrong-project": receipt.ProjectId = Guid.NewGuid(); break;
            case "wrong-mutation": receipt.ClientMutationId = OtherMutationId; break;
            case "missing-digest": receipt.RequestDigest = null!; break;
            case "short-digest": receipt.RequestDigest = [42]; break;
        }

        Assert.Throws<ArgumentException>(() =>
            ProjectSavePolicy.Decide(Snapshot(12), 11, MutationId, Digest, receipt));
    }

    private static ProjectSaveReceipt Receipt(long revision = 12) => new()
    {
        ProjectId = Snapshot(revision).ProjectId,
        ActorId = ActorId,
        ClientMutationId = MutationId,
        ExpectedRevision = revision - 1,
        Revision = revision,
        RequestDigest = Digest.ToArray(),
        SavedAt = DateTimeOffset.UnixEpoch,
    };

    private static ProjectAccessSnapshot Snapshot(long revision) => new(
        ActorId, Guid.Parse("44444444-4444-4444-8444-444444444444"),
        Guid.Parse("55555555-5555-4555-8555-555555555555"),
        IsArchived: false, revision, SchemaVersion: 1, UnvalidatedDocumentJson: "{}",
        UpdatedAt: DateTimeOffset.UnixEpoch, LastMutationActorId: null, LastMutationId: null,
        LastMutationDigest: null, CanEdit: true, CanManage: false, CanPublish: false);
}
