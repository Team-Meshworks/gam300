using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

public static partial class AccountDirectoryEndpoints
{
    private sealed record DeleteStudentsRequest(Guid[] UserIds);

    private static Task<IResult> DeleteStudentsAsync(Guid id, DeleteStudentsRequest request, HttpContext context,
        ApplicationDbContext database, UserManager<ApplicationUser> users, CurrentAccountResolver accounts, CancellationToken cancellationToken) =>
        ChangeStudentsAsync(id, request, context, database, users, accounts, cancellationToken, delete: true);

    private static Task<IResult> HideStudentsAsync(Guid id, DeleteStudentsRequest request, HttpContext context,
        ApplicationDbContext database, UserManager<ApplicationUser> users, CurrentAccountResolver accounts, CancellationToken cancellationToken) =>
        ChangeStudentsAsync(id, request, context, database, users, accounts, cancellationToken, delete: false);

    private static async Task<IResult> ChangeStudentsAsync(Guid id, DeleteStudentsRequest request,
        HttpContext context, ApplicationDbContext database, UserManager<ApplicationUser> users,
        CurrentAccountResolver accounts, CancellationToken cancellationToken, bool delete)
    {
        if (request.UserIds is not { Length: > 0 and <= 1000 } || request.UserIds.Contains(Guid.Empty))
        {
            return ApiProblems.Create(context, 400, "invalid_student_selection", "Select between 1 and 1000 creators in this organisation.");
        }
        var ids = request.UserIds.Distinct().ToArray();
        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        await database.Database.ExecuteSqlRawAsync("""LOCK TABLE "AspNetUserRoles" IN SHARE ROW EXCLUSIVE MODE""", cancellationToken);
        var organization = await database.Organizations.FromSqlInterpolated(
            $"SELECT * FROM organizations WHERE id = {id} FOR UPDATE").SingleOrDefaultAsync(cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        if (organization is null) { return OrganizationNotFound(context); }
        var selected = await database.Users.Where(user => ids.Contains(user.Id)
            && database.OrganizationMemberships.Any(member => member.OrganizationId == id
                && member.UserId == user.Id && member.RoleId == ApplicationRoles.CreatorId)
            && database.UserRoles.Any(role => role.UserId == user.Id && role.RoleId == ApplicationRoles.CreatorId)
            && !database.UserRoles.Any(role => role.UserId == user.Id && role.RoleId != ApplicationRoles.CreatorId))
            .OrderBy(user => user.Id).ToListAsync(cancellationToken);
        if (selected.Count != ids.Length)
        {
            return ApiProblems.Create(context, 400, "invalid_student_selection", "Only creator accounts from this organisation can be selected. Refresh before retrying.");
        }
        foreach (var user in selected.Where(user => !user.IsDeleted && (delete || user.IsActive)))
        {
            // Revoke sessions while retaining authored work and reserved usernames.
            if (delete) { user.IsDeleted = true; }
            user.IsActive = false;
            cancellationToken.ThrowIfCancellationRequested();
            var result = await users.UpdateSecurityStampAsync(user);
            if (!result.Succeeded) { return AccountAdministrationEndpoints.ToProblem(context, result); }
        }
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } revoked) { return revoked; }
        return await CompleteAsync(context, transaction, Results.NoContent(), cancellationToken);
    }
}
