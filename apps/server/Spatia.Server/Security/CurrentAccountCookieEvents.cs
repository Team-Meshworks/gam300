using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Spatia.Server.Hosting;

namespace Spatia.Server.Security;

/// <summary>
/// Enforces absolute session expiry, refreshes current account authority and returns API authentication failures
/// </summary>
/// <param name="accounts">The resolver for current account state and credential stamps</param>
/// <param name="identityOptions">The Identity options defining user identifier and security stamp claim types</param>
public sealed class CurrentAccountCookieEvents(CurrentAccountResolver accounts, IOptions<IdentityOptions> identityOptions)
    : CookieAuthenticationEvents
{
    private const string AbsoluteExpiryKey = "spatia.absoluteExpiresUtc";

    /// <summary>
    /// Issues a nonpersistent cookie with an eight-hour cutoff while preserving any earlier absolute expiry
    /// </summary>
    /// <param name="context">The sign-in event containing the ticket properties and cookie options</param>
    /// <returns>A completed task after the cookie and ticket expiry settings are updated</returns>
    /// <exception cref="InvalidOperationException">An existing absolute expiry value is invalid</exception>
    public override Task SigningIn(CookieSigningInContext context)
    {
        var now = (context.Options.TimeProvider ?? TimeProvider.System).GetUtcNow();
        var cutoff = now.AddHours(8);
        if (context.Properties.Items.ContainsKey(AbsoluteExpiryKey))
        {
            if (!TryGetAbsoluteExpiry(context.Properties, out var existingCutoff))
            {
                throw new InvalidOperationException("The session expiry state is invalid.");
            }

            if (existingCutoff < cutoff)
            {
                cutoff = existingCutoff;
            }
        }

        context.Properties.Items[AbsoluteExpiryKey] = cutoff.UtcTicks.ToString(CultureInfo.InvariantCulture);
        context.Properties.IssuedUtc = now;
        context.Properties.ExpiresUtc = cutoff;
        context.Properties.IsPersistent = false;
        context.CookieOptions.Expires = null;
        context.CookieOptions.MaxAge = null;
        return Task.CompletedTask;
    }

    /// <summary>
    /// Rejects expired or revoked sessions and replaces role claims with currently authorized account state
    /// </summary>
    /// <param name="context">The cookie validation event and request receiving the validated account features</param>
    /// <returns>A task completing after validation or session rejection</returns>
    /// <exception cref="OperationCanceledException">The request is canceled during account lookup</exception>
    public override async Task ValidatePrincipal(CookieValidatePrincipalContext context)
    {
        context.HttpContext.Features.Set<ValidatedAccountSession>(null);
        var clock = context.Options.TimeProvider ?? TimeProvider.System;
        if (!TryGetAbsoluteExpiry(context.Properties, out var cutoff) || cutoff <= clock.GetUtcNow())
        {
            await RejectAsync(context);
            return;
        }

        await SecurityStampValidator.ValidatePrincipalAsync(context);
        if (context.Principal is null)
        {
            return;
        }

        var claims = identityOptions.Value.ClaimsIdentity;
        var userIds = context.Principal.FindAll(claims.UserIdClaimType).ToArray();
        var stamps = context.Principal.FindAll(claims.SecurityStampClaimType).ToArray();
        if (userIds.Length != 1 || !Guid.TryParseExact(userIds[0].Value, "D", out var userId)
            || stamps.Length != 1 || string.IsNullOrEmpty(stamps[0].Value))
        {
            await RejectAsync(context);
            return;
        }

        var current = await accounts.ResolveAsync(userId, stamps[0].Value, context.HttpContext.RequestAborted);
        if (current is null)
        {
            await RejectAsync(context);
            return;
        }

        if (cutoff <= clock.GetUtcNow())
        {
            await RejectAsync(context);
            return;
        }

        foreach (var identity in context.Principal.Identities)
        {
            foreach (var claim in identity.FindAll(identity.RoleClaimType).ToArray())
            {
                identity.RemoveClaim(claim);
            }
        }

        if (context.Principal.Identity is not ClaimsIdentity applicationIdentity)
        {
            await RejectAsync(context);
            return;
        }

        applicationIdentity.AddClaim(new Claim(applicationIdentity.RoleClaimType, current.Role));
        context.HttpContext.Features.Set(current);
        context.HttpContext.Features.Set(new ValidatedAccountSession(userId, stamps[0].Value, cutoff, clock));
    }

    /// <summary>
    /// Writes a 401 authentication problem in place of a login redirect
    /// </summary>
    /// <param name="context">The cookie challenge event and HTTP response to complete</param>
    /// <returns>A task completing after the problem response is written</returns>
    public override Task RedirectToLogin(RedirectContext<CookieAuthenticationOptions> context)
        => ApiProblems.Create(context.HttpContext, 401, "authentication_required", "A valid session is required.")
            .ExecuteAsync(context.HttpContext);

    /// <summary>
    /// Writes a 403 access problem in place of an access-denied redirect
    /// </summary>
    /// <param name="context">The cookie forbid event and HTTP response to complete</param>
    /// <returns>A task completing after the problem response is written</returns>
    public override Task RedirectToAccessDenied(RedirectContext<CookieAuthenticationOptions> context)
        => ApiProblems.Create(context.HttpContext, 403, "access_denied", "This operation is not permitted.")
            .ExecuteAsync(context.HttpContext);

    private static bool TryGetAbsoluteExpiry(AuthenticationProperties properties, out DateTimeOffset cutoff)
    {
        cutoff = default;
        if (!properties.Items.TryGetValue(AbsoluteExpiryKey, out var value)
            || !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)
            || ticks < DateTimeOffset.MinValue.UtcTicks || ticks > DateTimeOffset.MaxValue.UtcTicks)
        {
            return false;
        }

        cutoff = new DateTimeOffset(ticks, TimeSpan.Zero);
        return true;
    }

    private static async Task RejectAsync(CookieValidatePrincipalContext context)
    {
        context.RejectPrincipal();
        await context.HttpContext.SignOutAsync(IdentityConstants.ApplicationScheme);
    }
}
