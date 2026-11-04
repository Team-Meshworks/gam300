using System.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

public static partial class AccountDirectoryEndpoints
{
    private static async Task<IResult> UpdateUserAsync(Guid id, UpdateAccountRequest request, HttpContext context,
        ApplicationDbContext database, UserManager<ApplicationUser> users, CurrentAccountResolver accounts,
        CancellationToken cancellationToken)
    {
        static bool ValidName(string? value) => value is null
            || (value.Length is > 0 and <= 256 && !string.IsNullOrWhiteSpace(value) && !value.Contains('\0'));
        if (!ValidName(request.DisplayName) || !ValidName(request.UserName)
            || request.Role is not (null or ApplicationRoles.Creator or ApplicationRoles.Educator)
            || request.NewTemporaryPassword is { Length: < 12 or > 128 })
        {
            return ApiProblems.Create(context, 400, "invalid_account_input", "Check the account details and password requirements.");
        }

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        // Serialize role changes with account lifecycle and bootstrap operations.
        await database.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE", cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var user = await users.FindByIdAsync(id.ToString("D"));
        if (user is null) { return ApiProblems.Create(context, 404, "account_not_found", "The account was not found."); }
        await database.Entry(user).ReloadAsync(cancellationToken);
        var membership = await database.OrganizationMemberships.AsNoTracking().SingleOrDefaultAsync(row => row.UserId == id, cancellationToken);
        var role = (await users.GetRolesAsync(user)).Single();
        var changeRole = request.Role is not null && request.Role != role;
        if (changeRole && (membership is null || role == ApplicationRoles.Administrator))
        {
            return ApiProblems.Create(context, 400, "invalid_account_input", "Only organisation account types can be changed here.");
        }
        if (changeRole && (await database.ClassroomMembers.AnyAsync(row => row.UserId == id, cancellationToken)
            || await database.ClassAssignmentStudents.AnyAsync(row => row.StudentId == id, cancellationToken)))
        {
            return RoleInUse(context);
        }

        try
        {
            if (changeRole)
            {
                // Class and assignment history references the original role; never rewrite that history.
                await database.OrganizationMemberships.Where(row => row.UserId == id).ExecuteDeleteAsync(cancellationToken);
                var removed = await users.RemoveFromRoleAsync(user, role);
                if (!removed.Succeeded) { return AccountAdministrationEndpoints.ToProblem(context, removed); }
                var assigned = await users.AddToRoleAsync(user, request.Role!);
                if (!assigned.Succeeded) { return AccountAdministrationEndpoints.ToProblem(context, assigned); }
                database.OrganizationMemberships.Add(new OrganizationMembership
                {
                    UserId = id,
                    OrganizationId = membership!.OrganizationId,
                    RoleId = request.Role == ApplicationRoles.Creator ? ApplicationRoles.CreatorId : ApplicationRoles.EducatorId,
                });
                await database.SaveChangesAsync(cancellationToken);
                role = request.Role!;
            }
            if (request.DisplayName is not null) { user.DisplayName = request.DisplayName.Trim(); }
            if (request.UserName is not null) { user.UserName = request.UserName.Trim(); }
            IdentityResult result;
            if (request.NewTemporaryPassword is { } password)
            {
                user.MustChangePassword = true;
                var token = await users.GeneratePasswordResetTokenAsync(user);
                result = await users.ResetPasswordAsync(user, token, password);
            }
            else
            {
                // Username/authority changes invalidate cookies carrying the old identity.
                result = await users.UpdateSecurityStampAsync(user);
            }
            if (!result.Succeeded) { return AccountAdministrationEndpoints.ToProblem(context, result); }
            if (await AuthorizeAsync(context, accounts, cancellationToken) is { } revoked && id != context.Features.Get<ValidatedAccountSession>()?.UserId)
            {
                return revoked;
            }
            return await CompleteAsync(context, transaction, Results.Ok(new ProvisionedAccount(id, user.UserName!, role,
                membership?.OrganizationId, user.IsActive, user.MustChangePassword, user.DisplayName ?? user.UserName)), cancellationToken);
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return ApiProblems.Create(context, 409, "username_taken", "That username is unavailable.");
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.ForeignKeyViolation)
        {
            return RoleInUse(context);
        }
    }

    private static IResult RoleInUse(HttpContext context) => ApiProblems.Create(context, 409, "account_role_in_use",
        "This account has class or assignment history. Its account type must be retained.");

    private static async Task<IResult> ListOrganizationProjectsAsync(Guid id, HttpContext context,
        ApplicationDbContext database, CurrentAccountResolver accounts, ProjectDocumentService documents, CancellationToken cancellationToken)
    {
        var page = ReadQuery(context.Request.Query, users: false);
        if (page is null || page.Limit > 20 || context.Request.Query.ContainsKey("isActive") || context.Request.Query.ContainsKey("q")) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        if (!await database.Organizations.AnyAsync(row => row.Id == id, cancellationToken))
        {
            return ApiProblems.Create(context, 404, "organization_not_found", "The organization was not found.");
        }
        var query = database.Projects.AsNoTracking().Where(row => row.OrganizationId == id);
        if (page.Cursor is { } cursor) { query = query.Where(row => row.Id.CompareTo(cursor) > 0); }
        var rows = await query.OrderBy(row => row.Id).Take(page.Limit + 1).ToListAsync(cancellationToken);
        var items = new List<object>();
        foreach (var row in rows.Take(page.Limit))
        {
            var document = documents.ReadStored(row.Id, row.SchemaVersion, row.DocumentJson);
            if (!document.Ok) { return ApiProblems.Create(context, 503, "project_unavailable", "Project details could not be loaded."); }
            var title = document.Value!.Title;
            if (title.Length > 256) { title = title[..(char.IsHighSurrogate(title[254]) ? 254 : 255)] + "…"; }
            items.Add(new { id = row.Id, title, status = row.IsArchived ? "Archived" : "Draft" });
        }
        return await CompleteAsync(context, transaction, Results.Ok(new
        {
            items,
            nextCursor = rows.Count > page.Limit ? rows[page.Limit - 1].Id : (Guid?)null,
        }), cancellationToken);
    }
}
