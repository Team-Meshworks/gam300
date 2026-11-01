using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

/// <summary>Compares a requested publication identity with its durable ledger entry</summary>
public static class PublicationRetryPolicy
{
    /// <summary>Replays only the same publication ID, project, actor, source revision and request digest</summary>
    /// <remarks>
    /// The caller must separately authorize current access and serialize insertion/commit.
    /// Pass the row looked up by publication ID, not the project's latest publication or draft.
    /// This deliberately does not compare the current draft revision: later edits cannot erase retry history.
    /// </remarks>
    public static PublicationRetryDecision Decide(Publication? existing, Guid publicationId, Guid projectId,
        Guid actorId, long sourceRevision, ReadOnlySpan<byte> requestDigest)
    {
        if (publicationId == Guid.Empty || projectId == Guid.Empty || actorId == Guid.Empty)
        {
            throw new ArgumentException("Publication, project and actor identifiers must be nonempty.");
        }
        if (sourceRevision < 0 || sourceRevision > Project.MaxRevision)
        {
            throw new ArgumentOutOfRangeException(nameof(sourceRevision));
        }
        if (requestDigest.Length != 32)
        {
            throw new ArgumentException("A request digest must contain exactly 32 bytes.", nameof(requestDigest));
        }
        if (existing is null)
        {
            return PublicationRetryDecision.CreateRequired;
        }
        if (existing.Id != publicationId || existing.RequestDigest is not { Length: 32 })
        {
            throw new ArgumentException("The persisted row must match the requested ID and contain a complete digest.", nameof(existing));
        }

        return existing.ProjectId == projectId && existing.PublishedById == actorId
            && existing.SourceRevision == sourceRevision && requestDigest.SequenceEqual(existing.RequestDigest)
            ? PublicationRetryDecision.Replay : PublicationRetryDecision.Conflict;
    }
}
