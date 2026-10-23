namespace Spatia.Server.Projects;

/// <summary>
/// Decides whether a locked draft requires a new write, an idempotent replay or a revision rejection
/// </summary>
public static class ProjectSavePolicy
{
    /// <summary>
    /// Compares revision and latest-mutation metadata without validating or saving a document
    /// </summary>
    /// <param name="project">The editable snapshot obtained while holding an EditDraft lock</param>
    /// <param name="expectedRevision">
    /// The client's original revision, from zero through <see cref="Project.MaxRevision"/>
    /// </param>
    /// <param name="clientMutationId">The stable identifier reused when retrying this mutation</param>
    /// <param name="requestDigest">
    /// The 32-byte server-derived digest bound to the document, project, actor and revision
    /// </param>
    /// <returns>The write, replay, conflict or revision exhaustion decision</returns>
    /// <remarks>
    /// Use an EditDraft-locked snapshot and retain the transaction through the eventual save
    /// Only the latest mutation is remembered when recognizing retries
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="project"/> is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">The expected revision is outside the supported range</exception>
    /// <exception cref="ArgumentException">The digest or editable snapshot metadata is invalid</exception>
    // TODO: Integrate SCRUM-50 validation and server-side request digest creation before wiring this into saves
    public static ProjectSaveDecision Decide(ProjectAccessSnapshot project, long expectedRevision,
        Guid clientMutationId, ReadOnlySpan<byte> requestDigest)
    {
        ArgumentNullException.ThrowIfNull(project);
        if (expectedRevision < 0 || expectedRevision > Project.MaxRevision)
        {
            throw new ArgumentOutOfRangeException(nameof(expectedRevision));
        }
        if (requestDigest.Length != 32)
        {
            throw new ArgumentException("A request digest must contain exactly 32 bytes.", nameof(requestDigest));
        }
        if (project.Revision < 0 || project.Revision > Project.MaxRevision || project.IsArchived || !project.CanEdit)
        {
            throw new ArgumentException("An editable snapshot with a bounded revision is required.", nameof(project));
        }

        var lastDigest = project.LastMutationDigest;
        if (project.LastMutationId.HasValue != project.LastMutationActorId.HasValue
            || project.LastMutationId.HasValue != lastDigest.HasValue
            || (lastDigest is { } storedDigest && (storedDigest.IsDefault || storedDigest.Length != 32)))
        {
            throw new ArgumentException("The latest mutation metadata must be absent or complete.", nameof(project));
        }

        // shortcut: Only the latest mutation is remembered, add a ledger if historical ID reuse must be rejected
        if (project.LastMutationId == clientMutationId)
        {
            // TODO: Bind digest creation to the SCRUM-50 representation, project, actor and original expected revision
            return project.LastMutationActorId == project.ActorId
                && expectedRevision == project.Revision - 1
                && lastDigest!.Value.AsSpan().SequenceEqual(requestDigest)
                ? ProjectSaveDecision.Replay : ProjectSaveDecision.Conflict;
        }
        if (expectedRevision != project.Revision)
        {
            return ProjectSaveDecision.Conflict;
        }

        // TODO: Apply a WriteRequired decision only after SCRUM-50 validation in the locked atomic save transaction
        return project.Revision == Project.MaxRevision
            ? ProjectSaveDecision.RevisionExhausted : ProjectSaveDecision.WriteRequired;
    }
}
