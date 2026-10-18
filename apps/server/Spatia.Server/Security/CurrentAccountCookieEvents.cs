using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Spatia.Server.Hosting;

namespace Spatia.Server.Security;

public sealed class CurrentAccountCookieEvents(CurrentAccountResolver accounts, IOptions<IdentityOptions> identityOptions)
    : CookieAuthenticationEvents
{
    private const string AbsoluteExpiryKey = "spatia.absoluteExpiresUtc";

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

    public override async Task ValidatePrincipal(CookieValidatePrincipalContext context)
    {
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
    }

    public override Task RedirectToLogin(RedirectContext<CookieAuthenticationOptions> context)
        => ApiProblems.Create(context.HttpContext, 401, "authentication_required", "A valid session is required.")
            .ExecuteAsync(context.HttpContext);

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
