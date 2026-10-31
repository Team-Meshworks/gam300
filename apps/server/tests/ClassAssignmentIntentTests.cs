using Spatia.Server.Classes;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

public sealed class ClassAssignmentIntentTests
{
    [Test]
    public async Task AssignmentIntent_ValidatesRequiredMetadataDeadlineAndBoundedStudents()
    {
        var valid = Request();
        await Assert.That(ClassAssignmentIntent.IsValid(valid)).IsTrue();
        await Assert.That(ClassAssignmentIntent.IsValid(valid with { DueAtUnixSeconds = ClassAssignment.MinimumUnixSeconds })).IsTrue();
        await Assert.That(ClassAssignmentIntent.IsValid(valid with { DueAtUnixSeconds = ClassAssignment.MaximumUnixSeconds })).IsTrue();
        var invalid = new[]
        {
            valid with { RequestId = null }, valid with { RequestId = Guid.Empty },
            valid with { SourceProjectId = Guid.Empty }, valid with { SourceRevision = -1 },
            valid with { SourceRevision = Project.MaxRevision + 1 }, valid with { DueAtUnixSeconds = null },
            valid with { DueAtUnixSeconds = ClassAssignment.MinimumUnixSeconds - 1 },
            valid with { DueAtUnixSeconds = ClassAssignment.MaximumUnixSeconds + 1 },
            valid with { Title = " " }, valid with { Title = new string('x', 257) },
            valid with { Description = "\0" }, valid with { Instructions = "\ud800" },
            valid with { Instructions = "\udc00" }, valid with { StudentIds = [] },
            valid with { StudentIds = [Guid.Empty] }, valid with { StudentIds = [valid.StudentIds![0], valid.StudentIds[0]] },
            valid with { StudentIds = Enumerable.Range(0, ClassAssignmentIntent.MaximumStudents + 1).Select(_ => Guid.NewGuid()).ToArray() },
        };
        foreach (var request in invalid) { await Assert.That(ClassAssignmentIntent.IsValid(request)).IsFalse(); }
        await Assert.That(ClassAssignmentIntent.IsValid(valid with { Instructions = "Review 🌏" })).IsTrue();
    }

    [Test]
    public async Task AssignmentIntent_RetryDigestBindsActorMetadataAndTheStudentSet()
    {
        var request = Request();
        var classroom = Guid.NewGuid();
        var actor = Guid.NewGuid();
        var digest = ClassAssignmentIntent.Digest(request, classroom, actor);
        await Assert.That(digest.Length).IsEqualTo(32);
        await Assert.That(digest.SequenceEqual(ClassAssignmentIntent.Digest(request with { StudentIds = request.StudentIds!.Reverse().ToArray() }, classroom, actor))).IsTrue();
        await Assert.That(digest.SequenceEqual(ClassAssignmentIntent.Digest(request with { Title = request.Title + " changed" }, classroom, actor))).IsFalse();
        await Assert.That(digest.SequenceEqual(ClassAssignmentIntent.Digest(request with { DueAtUnixSeconds = request.DueAtUnixSeconds + 1 }, classroom, actor))).IsFalse();
        await Assert.That(digest.SequenceEqual(ClassAssignmentIntent.Digest(request, classroom, Guid.NewGuid()))).IsFalse();
        await Assert.That(digest.SequenceEqual(ClassAssignmentIntent.Digest(request, Guid.NewGuid(), actor))).IsFalse();
        Assert.Throws<ArgumentException>(() => ClassAssignmentIntent.Digest(request with { StudentIds = [] }, classroom, actor));
    }

    private static ClassAssignmentRequest Request() => new(Guid.NewGuid(), Guid.NewGuid(), 0, 2_000_000_000,
        "Assignment", "Description", "Instructions", [Guid.NewGuid(), Guid.NewGuid()]);
}
