using Spatia.Server.Accounts;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Zero stays invalid so missing or unknown stored modes cannot expose a publication
internal enum PublicationAudience
{
    Public = 1,
    Unlisted = 2,
    Authenticated = 3,
}

internal enum PublicationReadKind
{
    Snapshot = 1,
    Asset = 2,
}

// Build each access decision from current server data
internal sealed record PublicationReadPolicy(
    PublicationAudience Audience,
    bool IsRevoked,
    bool IsAudienceMember)
{
    // Keep archive, hiding and revocation independent so restoring one cannot clear another
    // Check immutable asset membership before building an asset access decision
    internal static PublicationReadPolicy FromCurrentState(
        PublicationAudience audience, bool archived, bool hidden, bool revoked, bool deleted,
        Guid organizationId, Guid publisherId, CurrentAccount? account,
        bool namedViewer, bool canEdit, bool canPublish, bool canManage)
    {
        // Only active, unrestricted accounts returned by the current account resolver qualify
        // Global administrators need current project management authority, not a directory role alone
        // Resolve the organization boundary before evaluating the three ways to view
        var sameOrganization = account is not null && account.OrganizationId == organizationId
            && organizationId != Guid.Empty;
        var fullAccount = account is { MustChangePassword: false } && account.UserId != Guid.Empty;

        // Managers must currently manage this project; a directory role alone is insufficient
        var manager = fullAccount && canManage &&
            (account!.Role == ApplicationRoles.Administrator && account.OrganizationId is null
                || account.Role == ApplicationRoles.Educator && sameOrganization);

        // Keep publisher access while both edit and publish permissions remain
        var publisher = fullAccount && sameOrganization && account!.UserId == publisherId
            && publisherId != Guid.Empty && canEdit && canPublish;

        // A named viewer may be outside the project roster but must belong to its organization
        var named = fullAccount && sameOrganization && namedViewer;


        // Any active restriction blocks visitor access, even for a manager or named viewer
        return new(audience, archived || hidden || revoked || deleted, manager || publisher || named);
    }
}
