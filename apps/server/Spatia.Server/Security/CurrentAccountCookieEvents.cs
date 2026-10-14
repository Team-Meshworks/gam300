using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;

namespace Spatia.Server.Security;

public sealed class CurrentAccountCookieEvents(ApplicationDbContext database, IOptions<IdentityOptions> identityOptions)
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

        var current = await (
            from user in database.Users.AsNoTracking()
            where user.Id == userId
            join assignment in database.UserRoles on user.Id equals assignment.UserId into assignments
            from assignment in assignments.DefaultIfEmpty()
            join assignedRole in database.Roles
                on (assignment == null ? (Guid?)null : assignment.RoleId) equals (Guid?)assignedRole.Id
                into assignedRoles
            from assignedRole in assignedRoles.DefaultIfEmpty()
            join membership in database.OrganizationMemberships on user.Id equals membership.UserId into memberships
            from membership in memberships.DefaultIfEmpty()
            join organization in database.Organizations
                on (membership == null ? (Guid?)null : membership.OrganizationId) equals (Guid?)organization.Id
                into organizations
            from organization in organizations.DefaultIfEmpty()
            select new
            {
                user.UserName,
                user.IsActive,
                user.MustChangePassword,
                user.SecurityStamp,
                RoleId = assignment == null ? (Guid?)null : assignment.RoleId,
                RoleName = assignedRole == null ? null : assignedRole.Name,
                MembershipRoleId = membership == null ? (Guid?)null : membership.RoleId,
                OrganizationId = membership == null ? (Guid?)null : membership.OrganizationId,
                OrganizationActive = organization != null && organization.IsActive,
            }).SingleOrDefaultAsync(context.HttpContext.RequestAborted);

        if (current is null || !current.IsActive || string.IsNullOrEmpty(current.UserName)
            || current.SecurityStamp != stamps[0].Value)
        {
            await RejectAsync(context);
            return;
        }

        string role;
        if (current.RoleId == ApplicationRoles.AdministratorId
            && current.RoleName == ApplicationRoles.Administrator && current.OrganizationId is null)
        {
            role = ApplicationRoles.Administrator;
        }
        else if (current.OrganizationId is not null && current.OrganizationActive
            && current.MembershipRoleId == current.RoleId
            && (current.RoleId == ApplicationRoles.EducatorId || current.RoleId == ApplicationRoles.CreatorId)
            && current.RoleName == (current.RoleId == ApplicationRoles.EducatorId
                ? ApplicationRoles.Educator : ApplicationRoles.Creator))
        {
            role = current.RoleId == ApplicationRoles.EducatorId ? ApplicationRoles.Educator : ApplicationRoles.Creator;
        }
        else
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

        applicationIdentity.AddClaim(new Claim(applicationIdentity.RoleClaimType, role));
        context.HttpContext.Features.Set(new CurrentAccount(
            userId, current.UserName, role, current.OrganizationId, current.MustChangePassword));
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
