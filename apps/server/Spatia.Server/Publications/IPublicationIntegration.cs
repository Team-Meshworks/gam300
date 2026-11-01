using System.Collections.Frozen;
using System.Collections.Immutable;
using Spatia.ProjectFormat;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

/// <summary>Private transaction seam for origin, asset and audience owners; not their public contract</summary>
/// <remarks>
/// Every call uses the coordinator's context, read-committed transaction and retained project lock.
/// Implementations must not commit, mutate the draft, acquire project locks out of order, or emit
/// external effects. Preparation is read-only: it may be discarded on a competing global ID claim.
/// An absent contract must deny. Fixture implementations are not production approval or access policy.
/// </remarks>
internal interface IPublicationIntegration
{
    /// <summary>
    /// Validate the whole intent and new-edition policy; resolve approved immutable assets and the
    /// actual target player capabilities. Only an authoritative ordinary-origin contract may set
    /// OrdinaryOriginVerified. Missing class mapping or client content is not such evidence.
    /// The coordinator independently enforces approval for known class drafts.
    /// </summary>
    Task<PublicationPreparation> PrepareAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, IAuthoredProject document, CancellationToken cancellationToken);

    /// <summary>
    /// Check current access/revocation for this historical edition without publishing again, changing
    /// policy, or requiring approval of a later draft. This must validate the original intent too.
    /// </summary>
    Task<PublicationRejection?> AuthorizeReplayAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken);

    /// <summary>
    /// Stage and persist the new edition's owned policy records in the same transaction after the ledger insert.
    /// Return a denial to roll everything back; never stage or reset policy for an existing edition.
    /// </summary>
    Task<PublicationRejection?> StageAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken);
}

internal sealed class PublicationPreparation
{
    private PublicationPreparation(PublicationRejection? failure, IEnumerable<PublicationAssetReference> references,
        IEnumerable<string> capabilities, bool ordinaryOriginVerified = false)
    {
        Failure = failure;
        References = references.ToImmutableArray();
        SupportedCapabilities = capabilities.ToFrozenSet(StringComparer.Ordinal);
        OrdinaryOriginVerified = ordinaryOriginVerified;
    }

    public PublicationRejection? Failure { get; }
    public ImmutableArray<PublicationAssetReference> References { get; }
    public IReadOnlySet<string> SupportedCapabilities { get; }
    public bool OrdinaryOriginVerified { get; }

    public static PublicationPreparation Ready(IEnumerable<PublicationAssetReference> references,
        IEnumerable<string> supportedCapabilities, bool ordinaryOriginVerified = false) =>
        new(null, references, supportedCapabilities, ordinaryOriginVerified);
    public static PublicationPreparation Denied(PublicationRejection failure) => new(failure, [], []);
}

/// <summary>No permissive default, development catalogue approval or inferred direct-project exemption</summary>
internal sealed class UnavailablePublicationIntegration : IPublicationIntegration
{
    public Task<PublicationPreparation> PrepareAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, IAuthoredProject document, CancellationToken cancellationToken) =>
        Task.FromResult(PublicationPreparation.Denied(PublicationRejection.DependencyUnavailable));

    public Task<PublicationRejection?> AuthorizeReplayAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken) =>
        Task.FromResult<PublicationRejection?>(PublicationRejection.DependencyUnavailable);

    public Task<PublicationRejection?> StageAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken) =>
        Task.FromResult<PublicationRejection?>(PublicationRejection.DependencyUnavailable);
}
