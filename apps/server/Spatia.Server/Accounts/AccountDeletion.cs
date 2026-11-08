using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

public static partial class AccountDirectoryEndpoints
{
    private static async Task<IResult> DeleteAccountAsync(Guid id, HttpContext context,
        ApplicationDbContext database, UserManager<ApplicationUser> users, CurrentAccountResolver accounts,
        CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        // Share role and lifecycle lock order so a waiting request cannot retain revoked authority
        await database.Database.ExecuteSqlRawAsync("""LOCK TABLE "AspNetUserRoles" IN SHARE ROW EXCLUSIVE MODE""", cancellationToken);
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } failure) { return failure; }
        var user = await users.FindByIdAsync(id.ToString("D"));
        if (user is null) { return ApiProblems.Create(context, 404, "account_not_found", "The account was not found."); }
        await database.Entry(user).ReloadAsync(cancellationToken);
        if (id == context.Features.Get<ValidatedAccountSession>()?.UserId
            || await users.IsInRoleAsync(user, ApplicationRoles.Administrator))
        {
            return ApiProblems.Create(context, 403, "account_delete_forbidden", "Platform administrator accounts cannot be deleted here.");
        }
        if (!user.IsDeleted)
        {
            // Retain authored projects, review history and the reserved username without retaining access
            user.IsDeleted = true;
            user.IsActive = false;
            cancellationToken.ThrowIfCancellationRequested();
            var result = await users.UpdateSecurityStampAsync(user);
            if (!result.Succeeded) { return AccountAdministrationEndpoints.ToProblem(context, result); }
        }
        if (await AuthorizeAsync(context, accounts, cancellationToken) is { } revoked) { return revoked; }
        return await CompleteAsync(context, transaction, Results.NoContent(), cancellationToken);
    }
}
