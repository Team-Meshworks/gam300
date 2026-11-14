using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

/// <summary>
/// Maps account provisioning and credential administration endpoints
/// </summary>
public static class AccountAdministrationEndpoints
{
    /// <summary>
    /// Adds account provisioning and password reset routes with administrator authorization
    /// </summary>
    /// <param name="endpoints">The route builder that receives the administration endpoints</param>
    /// <returns>The supplied route builder for further endpoint registration</returns>
    public static IEndpointRouteBuilder MapAccountAdministration(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/admin")
            .RequireAuthorization(SecurityPolicies.Administrator)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapPost("/users", async (ProvisionAccountRequest request, AccountAdministrationService administration,
            HttpContext context, ApplicationDbContext database, CurrentAccountResolver accounts, CancellationToken cancellationToken) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
            // Serialize provisioning with account lifecycle changes and the last-administrator safeguard.
            await database.Database.ExecuteSqlRawAsync("""LOCK TABLE "AspNetUserRoles" IN SHARE ROW EXCLUSIVE MODE""", cancellationToken);
            if (await AccountDirectoryEndpoints.AuthorizeAsync(context, accounts, cancellationToken) is { } denied) { return denied; }
            var outcome = await administration.ProvisionAccountAsync(request, cancellationToken);
            if (!outcome.Result.Succeeded) { return ToProblem(context, outcome.Result); }
            if (await AccountDirectoryEndpoints.AuthorizeAsync(context, accounts, cancellationToken) is { } changed) { return changed; }
            return await AccountDirectoryEndpoints.CompleteAsync(context, transaction,
                Results.Created($"{ApiV1Endpoints.Prefix}/admin/users/{outcome.Account!.UserId:D}", outcome.Account), cancellationToken);
        });
        group.MapPost("/users/bulk", AccountDirectoryEndpoints.LegacyBulkImportAsync);
        group.MapPost("/users/{id:guid}/password", async (Guid id, ResetAccountPasswordRequest request,
            AccountAdministrationService administration, ApplicationDbContext database, CurrentAccountResolver accounts,
            HttpContext context, CancellationToken cancellationToken) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
            await database.Database.ExecuteSqlRawAsync("""LOCK TABLE "AspNetUserRoles" IN SHARE MODE""", cancellationToken);
            if (await AccountDirectoryEndpoints.AuthorizeAsync(context, accounts, cancellationToken) is { } denied) { return denied; }
            var outcome = await administration.ResetPasswordAsync(id, request, cancellationToken);
            if (!outcome.Succeeded) { return ToProblem(context, outcome); }
            // A self-reset changes this session's stamp, so a second stamp check would reject its own write.
            if (id != context.Features.Get<ValidatedAccountSession>()!.UserId
                && await AccountDirectoryEndpoints.AuthorizeAsync(context, accounts, cancellationToken) is { } changed) { return changed; }
            return await AccountDirectoryEndpoints.CompleteAsync(context, transaction, Results.NoContent(), cancellationToken);
        });
        return endpoints;
    }

    internal static IResult ToProblem(HttpContext context, IdentityResult result)
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
