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
    private static readonly Guid EditionId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid AccountId = Guid.Parse("22222222-2222-4222-8222-222222222222");

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

    [Test]
    // Apply each audience decision to both document and asset handlers
    public async Task PublicationRead_AudienceMatrixAppliesToBothSnapshotsAndAssets()
    {
        // Pair every audience with anonymous, named and administrator sessions
        // Repeat the decision for the edition JSON and its protected asset bytes
        foreach (var audience in Enum.GetValues<PublicationAudience>())
        {
            foreach (var actor in new[] { "anonymous", "permitted", "unrelated", "administrator", "permitted-administrator" })
            {
                foreach (var kind in Enum.GetValues<PublicationReadKind>())
                {
                    var member = actor is "permitted" or "permitted-administrator";
                    var reader = new Reader { Policy = new(audience, false, member) };
                    using var provider = Services(reader);
                    var context = Context(provider, kind);
                    if (actor != "anonymous")
                    {
                        Authenticate(context, administrator: actor.Contains("administrator", StringComparison.Ordinal));
                    }
                    // Record whether the protected handler ran, then compare the response and lookup inputs
                    var reached = false;
                    var result = await InvokeAsync(context, kind, () => reached = true);
                    var expected = audience != PublicationAudience.Authenticated || member;
                    await Assert.That(reached).IsEqualTo(expected);
                    await Assert.That(result is IStatusCodeHttpResult { StatusCode: 404 }).IsEqualTo(!expected);
                    await Assert.That(reader.Account?.UserId).IsEqualTo(actor == "anonymous" ? (Guid?)null : AccountId);
                    await Assert.That(reader.AssetId).IsEqualTo(kind == PublicationReadKind.Asset ? "image-v1" : null);
                }
            }
        }
    }

    [Test]
    [Arguments("revoked")]
    [Arguments("missing")]
    [Arguments("unknown-mode")]
    [Arguments("default-mode")]
    // Missing, unknown and revoked records must fail before either handler runs
    public async Task PublicationRead_InvalidOrRevokedPolicyDoesNotReachEitherHandler(string scenario)
    {
        foreach (var kind in Enum.GetValues<PublicationReadKind>())
        {
            var reader = new Reader
            {
                Policy = scenario switch
                {
                    "missing" => null,
                    "unknown-mode" => new((PublicationAudience)99, false, true),
                    "default-mode" => new(default, false, true),
                    _ => new(PublicationAudience.Public, true, true),
                },
            };
            using var provider = Services(reader);
            var context = Context(provider, kind);
            Authenticate(context, administrator: true);
            var reached = false;
            var result = await InvokeAsync(context, kind, () => reached = true);
            await Assert.That(reached).IsFalse();
            await Assert.That(result is IStatusCodeHttpResult { StatusCode: 404 }).IsTrue();
        }
    }

    [Test]
    [Arguments("claims-only")]
    [Arguments("no-session")]
    [Arguments("wrong-user")]
    [Arguments("expired")]
    [Arguments("forced-password")]
    [Arguments("unauthenticated")]
    // Claims, expired sessions and restricted accounts cannot become authenticated viewers
    public async Task PublicationRead_UntrustedOrRestrictedIdentityCannotUseAudienceMembership(string scenario)
    {
        var reader = new Reader { Policy = new(PublicationAudience.Authenticated, false, true) };
        using var provider = Services(reader);
        var context = Context(provider, PublicationReadKind.Snapshot);
        var clock = Authenticate(context);

        // Remove or alter one part of the otherwise valid session for each scenario
        if (scenario is "claims-only")
        {
            context.Features.Set<CurrentAccount>(null);
        }
        if (scenario is "claims-only" or "no-session")
        {
            context.Features.Set<ValidatedAccountSession>(null);
        }
        if (scenario == "wrong-user")
        {
            context.Features.Set(context.Features.Get<CurrentAccount>()! with { UserId = Guid.NewGuid() });
        }
        if (scenario == "expired")
        {
            clock.Advance(TimeSpan.FromHours(1));
        }
        if (scenario == "forced-password")
        {
            context.Features.Set(context.Features.Get<CurrentAccount>()! with { MustChangePassword = true });
        }
        if (scenario == "unauthenticated")
        {
            context.User = new ClaimsPrincipal(new ClaimsIdentity());
        }
        // Even a reader that reports membership must not receive an untrusted account
        var reached = false;
        var result = await InvokeAsync(context, PublicationReadKind.Snapshot, () => reached = true);
        await Assert.That(reached).IsFalse();
        await Assert.That(result is IStatusCodeHttpResult { StatusCode: 404 }).IsTrue();
        await Assert.That(reader.Account).IsNull();
    }

    [Test]
    // Recheck session expiry after storage access and respect cancellation
    public async Task PublicationRead_ExpiryOrCancellationDuringLookupNeverReadsProtectedBytes()
    {
        var reader = new Reader { Policy = new(PublicationAudience.Authenticated, false, true) };
        using var provider = Services(reader);
        var context = Context(provider, PublicationReadKind.Asset);
        var clock = Authenticate(context);
        // Expire the session while the lookup is in progress, before the filter resumes
        reader.BeforeReturn = () => clock.Advance(TimeSpan.FromHours(1));
        var reached = false;
        var result = await InvokeAsync(context, PublicationReadKind.Asset, () => reached = true);
        await Assert.That(result is IStatusCodeHttpResult { StatusCode: 404 }).IsTrue();
        await Assert.That(reached).IsFalse();

        // Cancel another lookup and make sure the handler never reads the asset
        using var cancellation = new CancellationTokenSource();
        context.RequestAborted = cancellation.Token;
        reader.Policy = new(PublicationAudience.Public, false, false);
        reader.BeforeReturn = cancellation.Cancel;
        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await InvokeAsync(context, PublicationReadKind.Asset, () => reached = true));
        await Assert.That(reader.Token).IsEqualTo(cancellation.Token);
        await Assert.That(reached).IsFalse();
    }

    private static ServiceProvider Services(Reader reader) => new ServiceCollection()
        .AddSingleton<IPublicationAccessReader>(reader).BuildServiceProvider();

    private static DefaultHttpContext Context(IServiceProvider services, PublicationReadKind kind)
    {
        var context = new DefaultHttpContext { RequestServices = services };
        context.Request.Method = "GET";
        context.Request.RouteValues["publicationId"] = EditionId.ToString("D");
        if (kind == PublicationReadKind.Asset)
        {
            context.Request.RouteValues["assetId"] = "image-v1";
        }
        return context;
    }

    // Supply matching account and session features so tests can change expiry independently
    private static TestTimeProvider Authenticate(HttpContext context, bool administrator = false)
    {
        var role = administrator ? ApplicationRoles.Administrator : ApplicationRoles.Creator;
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, AccountId.ToString("D")), new Claim(ClaimTypes.Role, role)], "synthetic-session"));
        context.Features.Set(new CurrentAccount(AccountId, "synthetic-reader", role, null, false));
        var clock = new TestTimeProvider();
        context.Features.Set(new ValidatedAccountSession(AccountId, "synthetic-stamp", clock.GetUtcNow().AddMinutes(1), clock));
        return clock;
    }

    private static ValueTask<object?> InvokeAsync(HttpContext context, PublicationReadKind kind, Action reached) =>
        new PublicationReadFilter(kind).InvokeAsync(new DefaultEndpointFilterInvocationContext(context), _ =>
        {
            reached();
            return ValueTask.FromResult<object?>("synthetic-protected-content");
        });

    // Synthetic editions keep publication storage out of these access-boundary tests
    private sealed class Reader : IPublicationAccessReader
    {
        internal PublicationReadPolicy? Policy = new(PublicationAudience.Public, false, false);
        internal Action? BeforeReturn;
        internal CurrentAccount? Account;
        internal string? AssetId;
        internal int Calls;
        internal CancellationToken Token;

        public ValueTask<PublicationReadPolicy?> ReadAsync(
            Guid publicationId, string? assetId, CurrentAccount? account, CancellationToken cancellationToken)
        {
            Calls++;
            Account = account;
            AssetId = assetId;
            Token = cancellationToken;
            BeforeReturn?.Invoke();
            return ValueTask.FromResult(publicationId == EditionId && (assetId is null or "image-v1") ? Policy : null);
        }
    }
}
