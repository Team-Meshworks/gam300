using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Attach to both snapshot and asset GET/HEAD routes before either handler reads protected bytes
internal sealed class PublicationReadFilter : IEndpointFilter
{
    private readonly PublicationReadKind _kind;

    internal PublicationReadFilter(PublicationReadKind kind)
    {
        if (!Enum.IsDefined(kind))
        {
            throw new ArgumentOutOfRangeException(nameof(kind));
        }
        _kind = kind;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext invocation,
        EndpointFilterDelegate next)
    {
        // Apply protected-response headers before any validation or error can return
        var context = invocation.HttpContext;
        // Apply again when headers start so a file handler cannot enable shared caching later
        SetPrivateHeaders(context.Response);
        context.Response.OnStarting(() =>
        {
            SetPrivateHeaders(context.Response);
            return Task.CompletedTask;
        });

        // Visitor access only permits reads, even if a route is accidentally mapped for writes
        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
        {
            context.Response.Headers.Allow = "GET, HEAD";
            return ApiProblems.Create(context, 405, "publication_read_only", "Publication access is read-only");
        }

        // Validate the edition and asset identifiers before asking storage for current access
        // Invalid identifiers share the same response as missing or inaccessible editions
        if (!Guid.TryParseExact(context.Request.RouteValues["publicationId"]?.ToString(), "D", out var publicationId)
            || publicationId == Guid.Empty)
        {
            return Unavailable(context);
        }

        var assetId = _kind == PublicationReadKind.Asset
            ? context.Request.RouteValues["assetId"] as string
            : null;
        if (_kind == PublicationReadKind.Asset && string.IsNullOrWhiteSpace(assetId))
        {
            return Unavailable(context);
        }

        // Resolve the current session before looking up access and immutable asset membership
        // Anonymous visitors still reach the lookup for public and unlisted editions
        var account = CurrentReader(context);
        var reader = context.RequestServices.GetRequiredService<IPublicationAccessReader>();
        var policy = await reader.ReadAsync(publicationId, assetId, account, context.RequestAborted);
        context.RequestAborted.ThrowIfCancellationRequested();

        // Recheck expiry after a slow lookup so it cannot extend the session
        var stillAuthenticated = account is not null && CurrentReader(context)?.UserId == account.UserId;
        // All lifecycle restrictions take priority over audience membership
        // Authenticated access additionally requires both a current session and reader approval
        var allowed = policy is { IsRevoked: false } && (policy.Audience switch
        {
            PublicationAudience.Public or PublicationAudience.Unlisted => true,
            PublicationAudience.Authenticated => stillAuthenticated && policy.IsAudienceMember,
            _ => false,
        });
        if (!allowed)
        {
            return Unavailable(context);
        }

        // Read protected content only after the access decision succeeds
        return await next(invocation);
    }

    // Require a matching current account and validated session instead of trusting claims alone
    private static CurrentAccount? CurrentReader(HttpContext context)
    {
        var account = context.Features.Get<CurrentAccount>();
        var session = context.Features.Get<ValidatedAccountSession>();
        return context.User.Identity?.IsAuthenticated == true
            && account is { MustChangePassword: false }
            && session is not null && session.UserId == account.UserId
            && session.Clock.GetUtcNow() < session.ExpiresUtc
                ? account
                : null;
    }

    // Use one response for missing, revoked and forbidden editions to avoid revealing existence
    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "publication_unavailable", "This publication is unavailable or access is not permitted");

    // Reapply these headers when the response starts to prevent downstream cache overrides
    private static void SetPrivateHeaders(HttpResponse response)
    {
        response.Headers.CacheControl = "private, no-store";
        response.Headers.Pragma = "no-cache";
        response.Headers.Expires = "0";
        response.Headers.XContentTypeOptions = "nosniff";
    }
}
