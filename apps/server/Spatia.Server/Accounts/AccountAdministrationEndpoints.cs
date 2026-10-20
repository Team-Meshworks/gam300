using Microsoft.AspNetCore.Identity;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

public static class AccountAdministrationEndpoints
{
    public static IEndpointRouteBuilder MapAccountAdministration(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/admin")
            .RequireAuthorization(SecurityPolicies.Administrator)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapPost("/organizations", async (CreateOrganizationRequest request, AccountAdministrationService administration,
            HttpContext context, CancellationToken cancellationToken) =>
        {
            var outcome = await administration.CreateOrganizationAsync(request, cancellationToken);
            return outcome.Result.Succeeded
                ? Results.Json(outcome.Organization, statusCode: StatusCodes.Status201Created)
                : ToProblem(context, outcome.Result);
        });
        group.MapPost("/users", async (ProvisionAccountRequest request, AccountAdministrationService administration,
            HttpContext context, CancellationToken cancellationToken) =>
        {
            var outcome = await administration.ProvisionAccountAsync(request, cancellationToken);
            return outcome.Result.Succeeded
                ? Results.Json(outcome.Account, statusCode: StatusCodes.Status201Created)
                : ToProblem(context, outcome.Result);
        });
        group.MapPost("/users/{id:guid}/password", async (Guid id, ResetAccountPasswordRequest request,
            AccountAdministrationService administration, HttpContext context, CancellationToken cancellationToken) =>
        {
            var outcome = await administration.ResetPasswordAsync(id, request, cancellationToken);
            return outcome.Succeeded ? Results.NoContent() : ToProblem(context, outcome);
        });
        return endpoints;
    }

    private static IResult ToProblem(HttpContext context, IdentityResult result)
    {
        var codes = result.Errors.Select(error => error.Code).ToHashSet(StringComparer.Ordinal);
        if (codes.Contains("DuplicateUserName"))
        {
            return ApiProblems.Create(context, 409, "username_taken", "That username is unavailable.");
        }
        if (codes.Contains("ConcurrencyFailure"))
        {
            return ApiProblems.Create(context, 409, "account_conflict", "The account changed; reload before retrying.");
        }
        if (codes.Contains("OrganizationUnavailable"))
        {
            return ApiProblems.Create(context, 422, "organization_unavailable", "Choose an active organization.");
        }
        if (codes.Contains("UserNotFound"))
        {
            return ApiProblems.Create(context, 404, "account_not_found", "The account was not found.");
        }
        return ApiProblems.Create(context, 400, "invalid_account_input", "Check the supplied account details and password requirements.");
    }
}
