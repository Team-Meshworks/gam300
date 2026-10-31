using System.Data;
using System.Globalization;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

/// <summary>
/// Exposes administrator-only account and organization directory operations without credential fields
/// </summary>
public static class AccountDirectoryEndpoints
{
    /// <summary>
    /// Maps bounded directory reads and lifecycle writes under the full administrator policy
    /// </summary>
    public static IEndpointRouteBuilder MapAccountDirectory(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/admin").RequireAuthorization(SecurityPolicies.Administrator);
        group.MapGet("/users", ListUsersAsync);
        group.MapGet("/users/{id:guid}", GetUserAsync);
        group.MapGet("/organizations", ListOrganizationsAsync);
        group.MapGet("/organizations/{id:guid}", GetOrganizationAsync);
        group.MapPatch("/users/{id:guid}/active", SetUserActiveAsync).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        return endpoints;
    }

    private static async Task<IResult> SetUserActiveAsync(Guid id, SetActiveRequest request, HttpContext context,
        ApplicationDbContext database, UserManager<ApplicationUser> users, CurrentAccountResolver accounts,
        CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        // Share bootstrap's lock so the last-administrator check also serializes with provisioning
        await database.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE", cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var user = await users.FindByIdAsync(id.ToString("D"));
        if (user is null) { return ApiProblems.Create(context, 404, "account_not_found", "The account was not found."); }
        // Cookie renewal may already have tracked this user before waiting for the lifecycle lock
        await database.Entry(user).ReloadAsync(cancellationToken);
        if (user.IsActive != request.IsActive)
        {
            if (!request.IsActive)
            {
                var administrators = await database.Users.Where(row => row.IsActive
                    && database.UserRoles.Any(role => role.UserId == row.Id && role.RoleId == ApplicationRoles.AdministratorId)
                    && !database.OrganizationMemberships.Any(member => member.UserId == row.Id))
                    .Select(row => row.Id).Take(2).ToListAsync(cancellationToken);
                if (administrators.Count == 1 && administrators[0] == id)
                {
                    return ApiProblems.Create(context, 409, "last_administrator", "Keep at least one active administrator.");
                }
            }
            user.IsActive = request.IsActive;
            cancellationToken.ThrowIfCancellationRequested();
            var result = request.IsActive ? await users.UpdateAsync(user) : await users.UpdateSecurityStampAsync(user);
            if (!result.Succeeded)
            {
                return result.Errors.Any(error => error.Code == "ConcurrencyFailure")
                    ? ApiProblems.Create(context, 409, "account_conflict", "The account changed; reload before retrying.")
                    : ApiProblems.Create(context, 400, "invalid_account_input", "The account state could not be changed.");
            }
        }
        return await CompleteAsync(context, transaction, Results.NoContent(), cancellationToken);
    }

    private static async Task<IResult> ListUsersAsync(HttpContext context, ApplicationDbContext database,
        CurrentAccountResolver accounts, CancellationToken cancellationToken)
    {
        var page = ReadQuery(context.Request.Query, users: true);
        if (page is null) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var query = database.Users.AsNoTracking();
        if (page.Cursor is { } cursor) { query = query.Where(row => row.Id.CompareTo(cursor) > 0); }
        if (page.IsActive is { } active) { query = query.Where(row => row.IsActive == active); }
        if (page.OrgId is { } orgId)
        {
            query = query.Where(row => database.OrganizationMemberships.Any(member => member.UserId == row.Id && member.OrganizationId == orgId));
        }
        if (page.Role is { } role)
        {
            query = query.Where(row => database.UserRoles.Any(assignment => assignment.UserId == row.Id
                && database.Roles.Any(assignedRole => assignedRole.Id == assignment.RoleId && assignedRole.Name == role)));
        }
        if (page.SearchPattern is { } pattern) { query = query.Where(row => EF.Functions.ILike(row.UserName!, pattern, "\\")); }
        var rows = await Users(database, query.OrderBy(row => row.Id).Take(page.Limit + 1)).ToListAsync(cancellationToken);
        var nextCursor = rows.Count > page.Limit ? rows[page.Limit - 1].UserId : (Guid?)null;
        return await CompleteAsync(context, transaction,
            Results.Ok(new { items = rows.Take(page.Limit).ToArray(), nextCursor }), cancellationToken);
    }

    private static async Task<IResult> ListOrganizationsAsync(HttpContext context, ApplicationDbContext database,
        CurrentAccountResolver accounts, CancellationToken cancellationToken)
    {
        var page = ReadQuery(context.Request.Query, users: false);
        if (page is null) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var query = database.Organizations.AsNoTracking();
        if (page.Cursor is { } cursor) { query = query.Where(row => row.Id.CompareTo(cursor) > 0); }
        if (page.IsActive is { } active) { query = query.Where(row => row.IsActive == active); }
        if (page.SearchPattern is { } pattern) { query = query.Where(row => EF.Functions.ILike(row.Name, pattern, "\\")); }
        var rows = await query.OrderBy(row => row.Id).Take(page.Limit + 1)
            .Select(row => new OrganizationResponse(row.Id, row.Name, row.IsActive)).ToListAsync(cancellationToken);
        var nextCursor = rows.Count > page.Limit ? rows[page.Limit - 1].Id : (Guid?)null;
        return await CompleteAsync(context, transaction,
            Results.Ok(new { items = rows.Take(page.Limit).ToArray(), nextCursor }), cancellationToken);
    }

    private static async Task<IResult> GetUserAsync(Guid id, HttpContext context, ApplicationDbContext database,
        CurrentAccountResolver accounts, CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var row = await Users(database, database.Users.AsNoTracking().Where(user => user.Id == id)).SingleOrDefaultAsync(cancellationToken);
        return await CompleteAsync(context, transaction, row is null
            ? ApiProblems.Create(context, 404, "account_not_found", "The account was not found.") : Results.Ok(row), cancellationToken);
    }

    private static async Task<IResult> GetOrganizationAsync(Guid id, HttpContext context, ApplicationDbContext database,
        CurrentAccountResolver accounts, CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var row = await database.Organizations.AsNoTracking().Where(organization => organization.Id == id)
            .Select(organization => new OrganizationResponse(organization.Id, organization.Name, organization.IsActive))
            .SingleOrDefaultAsync(cancellationToken);
        return await CompleteAsync(context, transaction, row is null
            ? ApiProblems.Create(context, 404, "organization_not_found", "The organization was not found.") : Results.Ok(row), cancellationToken);
    }

    private static IQueryable<ProvisionedAccount> Users(ApplicationDbContext database, IQueryable<ApplicationUser> users) =>
        from user in users
        join assignment in database.UserRoles on user.Id equals assignment.UserId
        join role in database.Roles on assignment.RoleId equals role.Id
        join membership in database.OrganizationMemberships on user.Id equals membership.UserId into memberships
        from membership in memberships.DefaultIfEmpty()
        orderby user.Id
        select new ProvisionedAccount(user.Id, user.UserName!, role.Name!,
            membership == null ? null : membership.OrganizationId, user.IsActive, user.MustChangePassword);

    private static DirectoryQuery? ReadQuery(IQueryCollection query, bool users)
    {
        var limit = 20;
        Guid? cursor = null;
        Guid? orgId = null;
        if (query.Any(pair => pair.Value.Count != 1 || (pair.Key is not ("limit" or "cursor" or "q" or "isActive")
                && (!users || pair.Key is not ("role" or "orgId"))))
            || (query.TryGetValue("limit", out var rawLimit)
                && (!int.TryParse(rawLimit, NumberStyles.None, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 100))
            || (query.TryGetValue("isActive", out var rawActive) && rawActive[0] is not ("true" or "false")))
        {
            return null;
        }
        if (query.TryGetValue("cursor", out var rawCursor))
        {
            if (rawCursor[0]?.Length != 36 || !Guid.TryParseExact(rawCursor[0], "D", out var id) || id == Guid.Empty) { return null; }
            cursor = id;
        }
        if (query.TryGetValue("orgId", out var rawOrg))
        {
            if (rawOrg[0]?.Length != 36 || !Guid.TryParseExact(rawOrg[0], "D", out var id) || id == Guid.Empty) { return null; }
            orgId = id;
        }
        var role = query.TryGetValue("role", out var rawRole) ? rawRole[0] : null;
        if (role is not (null or ApplicationRoles.Administrator or ApplicationRoles.Educator or ApplicationRoles.Creator)) { return null; }
        var search = query.TryGetValue("q", out var rawSearch) ? rawSearch[0] : null;
        if (search is { Length: > 256 } || search?.Contains('\0') == true) { return null; }
        var pattern = search is null ? null : "%" + search.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal) + "%";
        return new DirectoryQuery(limit, cursor, pattern, query.ContainsKey("isActive") ? query["isActive"] == "true" : null, role, orgId);
    }

    private static async Task<IResult?> AuthorizeAsync(HttpContext context, CurrentAccountResolver accounts,
        CancellationToken cancellationToken)
    {
        if (HasExpired(context) || context.User.Identity?.IsAuthenticated != true) { return AuthenticationRequired(context); }
        var session = context.Features.Get<ValidatedAccountSession>()!;
        var account = await accounts.ResolveAsync(session.UserId, session.SecurityStamp, cancellationToken);
        if (account is null || HasExpired(context)) { return AuthenticationRequired(context); }
        return account is { Role: ApplicationRoles.Administrator, MustChangePassword: false } ? null
            : ApiProblems.Create(context, 403, "forbidden", "Administrator access is required.");
    }

    private static async Task<IResult> CompleteAsync(HttpContext context, IDbContextTransaction transaction, IResult result,
        CancellationToken cancellationToken)
    {
        if (HasExpired(context)) { return AuthenticationRequired(context); }
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    private static IResult AuthenticationRequired(HttpContext context) =>
        ApiProblems.Create(context, 401, "authentication_required", "Sign in to continue.");

    private static IResult InvalidQuery(HttpContext context) =>
        ApiProblems.Create(context, 400, "invalid_directory_query", "Check the directory filters and cursor.");

    private sealed record DirectoryQuery(int Limit, Guid? Cursor, string? SearchPattern, bool? IsActive, string? Role, Guid? OrgId);
}
