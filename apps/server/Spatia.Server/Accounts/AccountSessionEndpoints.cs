using Microsoft.AspNetCore.Identity;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

/// <summary>
/// Maps sign-in, session inspection, sign-out and password change endpoints
/// </summary>
public static class AccountSessionEndpoints
{
    /// <summary>
    /// Adds account session routes with their authorization and rate limiting policies
    /// </summary>
    /// <param name="endpoints">The route builder that receives the session endpoints</param>
    /// <returns>The supplied route builder for further endpoint registration</returns>
    public static IEndpointRouteBuilder MapAccountSessions(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/auth");
        group.MapPost("/login", async (LoginRequest request, AccountSessionService sessions, HttpContext context,
            CancellationToken cancellationToken) =>
        {
            if (context.Features.Get<CurrentAccount>() is { MustChangePassword: true })
            {
                return ApiProblems.Create(context, 403, "access_denied", "This operation is not permitted.");
            }
            if (!AccountSessionService.IsValidLoginRequest(request))
            {
                return ApiProblems.Create(context, 400, "invalid_login_input", "Check the supplied sign-in details.");
            }

            var result = await sessions.LoginAsync(request, cancellationToken);
            return result.Succeeded
                ? Results.NoContent()
                : ApiProblems.Create(context, 401, "login_failed", "The sign-in details could not be accepted.");
        }).AllowAnonymous().RequireRateLimiting(SecurityPolicies.AuthenticationRateLimit);
        group.MapGet("/session", (HttpContext context) =>
        {
            var account = context.Features.Get<CurrentAccount>()!;
            return Results.Ok(new SessionResponse(
                account.UserId, account.UserName, account.Role, account.OrganizationId, account.MustChangePassword));
        }).RequireAuthorization(SecurityPolicies.CurrentAccount);
        group.MapPost("/logout", async (SignInManager<ApplicationUser> signIn) =>
        {
            await signIn.SignOutAsync();
            return Results.NoContent();
        }).RequireAuthorization(SecurityPolicies.CurrentAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapPost("/password", async (ChangePasswordRequest request, AccountSessionService sessions,
            HttpContext context, CancellationToken cancellationToken) =>
        {
            var result = await sessions.ChangePasswordAsync(request, cancellationToken);
            if (result.Succeeded)
            {
                return Results.NoContent();
            }
            var codes = result.Errors.Select(error => error.Code).ToHashSet(StringComparer.Ordinal);
            if (codes.Contains("AuthenticationRequired"))
            {
                return ApiProblems.Create(context, 401, "authentication_required", "A valid session is required.");
            }
            if (codes.Contains("ConcurrencyFailure"))
            {
                return ApiProblems.Create(context, 409, "account_conflict", "The account changed; reload before retrying.");
            }
            return ApiProblems.Create(context, 400, "password_change_failed", "Check the supplied password requirements.");
        }).RequireAuthorization(SecurityPolicies.CurrentAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        return endpoints;
    }
}
