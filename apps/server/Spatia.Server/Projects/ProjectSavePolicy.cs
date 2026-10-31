namespace Spatia.Server.Projects;

/// <summary>
/// Decides whether a locked draft requires a new write, an idempotent replay or a revision rejection
/// </summary>
public static class ProjectSavePolicy
{
    /// <summary>
    /// Compares the current revision and durable receipt without validating or saving a document
    /// </summary>
    /// <param name="project">The editable snapshot obtained while holding an EditDraft lock</param>
    /// <param name="expectedRevision">
    /// The client's original revision, from zero through <see cref="Project.MaxRevision"/>
    /// </param>
    /// <param name="clientMutationId">The stable identifier reused when retrying this mutation</param>
    /// <param name="requestDigest">
    /// The 32-byte server-derived digest bound to the document, project, actor and revision
    /// </param>
    /// <param name="receipt">The receipt for this project and mutation, or null for an unknown mutation</param>
    /// <returns>The write, replay, conflict or revision exhaustion decision</returns>
    /// <remarks>
    /// Use an EditDraft-locked snapshot and retain the transaction through the eventual save
    /// A known receipt remains authoritative after later content or metadata revisions
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="project"/> is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">The expected revision is outside the supported range</exception>
    /// <exception cref="ArgumentException">The digest or editable snapshot metadata is invalid</exception>
    public static ProjectSaveDecision Decide(ProjectAccessSnapshot project, long expectedRevision,
        Guid clientMutationId, ReadOnlySpan<byte> requestDigest, ProjectSaveReceipt? receipt)
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

        if (receipt is not null)
        {
            if (receipt.ProjectId != project.ProjectId || receipt.ClientMutationId != clientMutationId
                || receipt.RequestDigest is not { Length: 32 })
            {
                throw new ArgumentException("A complete receipt for this project and mutation is required.", nameof(receipt));
            }
            return receipt.ActorId == project.ActorId
                && expectedRevision == receipt.ExpectedRevision
                && receipt.RequestDigest.AsSpan().SequenceEqual(requestDigest)
                ? ProjectSaveDecision.Replay : ProjectSaveDecision.Conflict;
        }
        if (expectedRevision != project.Revision)
        {
            return ProjectSaveDecision.Conflict;
        }

        return project.Revision == Project.MaxRevision
            ? ProjectSaveDecision.RevisionExhausted : ProjectSaveDecision.WriteRequired;
    }
}
