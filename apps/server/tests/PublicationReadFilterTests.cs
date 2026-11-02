using System.Net;
using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Spatia.Server.Accounts;
using Spatia.Server.Publications;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

public sealed class PublicationReadFilterTests
{

    [Test]
    public async Task PublicationRead_CurrentAudienceHonoursOrganizationAndProjectPermissions()
    {
        // Build the original publisher, another organization member and an outside account
        // Use these accounts to exercise roster and project permission changes
        var organization = Guid.NewGuid();
        var publisherId = Guid.NewGuid();
        var publisher = new CurrentAccount(publisherId, "publisher", ApplicationRoles.Creator, organization, false);
        var peer = new CurrentAccount(Guid.NewGuid(), "peer", ApplicationRoles.Creator, organization, false);
        var outsider = peer with { OrganizationId = Guid.NewGuid() };
        var admin = peer with { Role = ApplicationRoles.Administrator, OrganizationId = null };

        // Permission-derived publisher access ends when editing or publishing permission is removed
        PublicationReadPolicy Policy(CurrentAccount? actor, bool named = false, bool edit = false,
            bool publish = false, bool manage = false) => PublicationReadPolicy.FromCurrentState(
                PublicationAudience.Authenticated, false, false, false, false, organization, publisherId,
                actor, named, edit, publish, manage);
        await Assert.That(Policy(publisher, edit: true, publish: true).IsAudienceMember).IsTrue();
        await Assert.That(Policy(publisher, edit: true).IsAudienceMember).IsFalse();
        await Assert.That(Policy(publisher, named: true).IsAudienceMember).IsTrue();

        // Named viewers need an eligible account in this organization, independent of project assignment
        await Assert.That(Policy(peer, named: true).IsAudienceMember).IsTrue();
        await Assert.That(Policy(outsider, named: true).IsAudienceMember).IsFalse();
        await Assert.That(Policy(peer with { MustChangePassword = true }, named: true).IsAudienceMember).IsFalse();
        await Assert.That(Policy(null, named: true).IsAudienceMember).IsFalse();

        // Global administrators qualify through current project management authority only
        await Assert.That(Policy(admin).IsAudienceMember).IsFalse();
        await Assert.That(Policy(admin, manage: true).IsAudienceMember).IsTrue();
        await Assert.That(Policy(peer, manage: true).IsAudienceMember).IsFalse();
        var educator = peer with { Role = ApplicationRoles.Educator };
        await Assert.That(Policy(educator, manage: true).IsAudienceMember).IsTrue();
        await Assert.That(Policy(educator with { OrganizationId = Guid.NewGuid() }, manage: true).IsAudienceMember).IsFalse();
    }

    [Test]
    public async Task PublicationRead_EachLifecycleRestrictionBlocksEveryAudience()
    {
        // Reopening or restoring one restriction cannot remove any remaining restriction
        foreach (var audience in Enum.GetValues<PublicationAudience>())
        {
            // Every nonzero combination represents at least one active restriction
            for (var mask = 1; mask < 16; mask++)
            {
                var policy = PublicationReadPolicy.FromCurrentState(audience,
                    (mask & 1) != 0, (mask & 2) != 0, (mask & 4) != 0, (mask & 8) != 0,
                    Guid.NewGuid(), Guid.NewGuid(), null, false, false, false, false);
                await Assert.That(policy.IsRevoked).IsTrue();
            }

            // Clear all restrictions before allowing the audience check to grant access
            var open = PublicationReadPolicy.FromCurrentState(audience, false, false, false, false,
                Guid.NewGuid(), Guid.NewGuid(), null, false, false, false, false);
            await Assert.That(open.IsRevoked).IsFalse();
        }
    }

}
