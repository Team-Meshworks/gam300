using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Use the publication store to supply current access for each immutable edition
// Read current policy on every request; return null for missing editions or assets outside that edition
// Resolve asset IDs through the edition's immutable asset list, never a client-supplied file path
internal interface IPublicationAccessReader
{
    // Pass the resolved session account, or null for an anonymous visitor
    // Look up current policy for every request instead of reusing a cached decision
    ValueTask<PublicationReadPolicy?> ReadAsync(
        Guid publicationId,
        string? assetId,
        CurrentAccount? account,
        CancellationToken cancellationToken);
}
