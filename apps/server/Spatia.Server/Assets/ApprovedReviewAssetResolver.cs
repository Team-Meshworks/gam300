using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Assets;

/// <summary>Resolves immutable approved asset versions for a confirmed class submission</summary>
internal sealed class ApprovedReviewAssetResolver : IReviewAssetResolver
{
    public async Task<IReadOnlyCollection<ReviewAssetReference>?> ResolveAsync(ApplicationDbContext database,
        ProjectAccessSnapshot project, IReadOnlySet<string> assetIds, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        // Review already authorizes the locked saved draft and derives these references from its validated content
        // Match canonical catalogue identities exactly so alternate UUID spellings cannot introduce aliases
        var ids = new List<Guid>(assetIds.Count);
        foreach (var assetId in assetIds)
        {
            if (!Guid.TryParseExact(assetId, "D", out var id) || id.ToString() != assetId)
            {
                return null;
            }
            ids.Add(id);
        }

        // Ordinary retirement hides new selections while retaining approved versions used by saved projects
        // Read fingerprints without loading binary payloads or changing the submission's transaction
        var references = await database.AssetCandidates.AsNoTracking()
            .Where(asset => ids.Contains(asset.Id) && asset.Status == "approved" && !asset.RemovedFromProjects)
            .Select(asset => new ReviewAssetReference(asset.Id.ToString(), asset.Sha256))
            .ToArrayAsync(cancellationToken);

        // Require the whole saved exhibit; a partial manifest must never become review evidence
        // PostgreSQL protects each stored version's identity, fingerprint and bytes from replacement
        return references.Length == assetIds.Count ? references : null;
    }
}
