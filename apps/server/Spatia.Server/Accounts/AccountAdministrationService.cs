using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Persistence;

namespace Spatia.Server.Accounts;

/// <summary>
/// Creates organizations and accounts and resets credentials in database transactions
/// </summary>
/// <param name="database">The scoped database context shared with the Identity stores</param>
/// <param name="users">The Identity manager used to validate and persist account credentials and roles</param>
/// <remarks>
/// Callers must enforce administrator authorization or the private bootstrap command boundary
/// </remarks>
public sealed class AccountAdministrationService(ApplicationDbContext database, UserManager<ApplicationUser> users)
{
    /// <summary>
    /// Creates the first administrator and requires a password change on first sign-in
    /// </summary>
    /// <param name="request">The initial administrator username and temporary password</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>The creation result, including refusal when an administrator already exists</returns>
    /// <exception cref="InvalidOperationException">The fixed account roles are unavailable</exception>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<IdentityResult> BootstrapAdministratorAsync(
        BootstrapAdministratorRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request is null)
        {
            return Failure("InvalidInput");
        }

        var provision = new ProvisionAccountRequest
        {
            UserName = request.UserName,
            InitialPassword = request.InitialPassword,
            Role = ApplicationRoles.Administrator,
            OrgId = null,
        };
        if (!IsValidAccount(provision))
        {
            return Failure("InvalidInput");
        }

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            await database.Database.ExecuteSqlRawAsync(
                "LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE", cancellationToken);
            if (await database.UserRoles.AnyAsync(role => role.RoleId == ApplicationRoles.AdministratorId, cancellationToken))
            {
                return Failure("BootstrapAlreadyExists");
            }

            var outcome = await ProvisionCoreAsync(provision, cancellationToken);
            if (!outcome.Result.Succeeded)
            {
                return outcome.Result;
            }

            cancellationToken.ThrowIfCancellationRequested();
            await transaction.CommitAsync(cancellationToken);
            return IdentityResult.Success;
        }
        catch (DbUpdateException exception) when (IsDuplicateUserName(exception))
        {
            return Failure("DuplicateUserName");
        }
    }

    /// <summary>
    /// Creates an active organization after validating its name
    /// </summary>
    /// <param name="request">The requested organization name</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>The creation result and organization details, or a failure result with no organization</returns>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<(IdentityResult Result, OrganizationResponse? Organization)> CreateOrganizationAsync(
        CreateOrganizationRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request is null || !IsValidName(request.Name) || request.Name.Contains('\0'))
        {
            return (Failure("InvalidInput"), null);
        }

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var organization = new Organization { Name = request.Name };
        database.Organizations.Add(organization);
        await database.SaveChangesAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        await transaction.CommitAsync(cancellationToken);
        return (IdentityResult.Success, new OrganizationResponse(organization.Id, organization.Name, organization.IsActive));
    }

    /// <summary>
    /// Creates an account with its fixed role and, when required, active organization membership
    /// </summary>
    /// <param name="request">The username, temporary password, role and organization assignment</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>The creation result and account details, or a failure result with no account</returns>
    /// <exception cref="InvalidOperationException">The fixed account roles are unavailable</exception>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<(IdentityResult Result, ProvisionedAccount? Account)> ProvisionAccountAsync(
        ProvisionAccountRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidAccount(request))
        {
            return (Failure("InvalidInput"), null);
        }

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            var outcome = await ProvisionCoreAsync(request, cancellationToken);
            if (!outcome.Result.Succeeded)
            {
                return outcome;
            }

            cancellationToken.ThrowIfCancellationRequested();
            await transaction.CommitAsync(cancellationToken);
            return outcome;
        }
        catch (DbUpdateException exception) when (IsDuplicateUserName(exception))
        {
            return (Failure("DuplicateUserName"), null);
        }
    }

    /// <summary>
    /// Sets a temporary password, invalidates existing credential stamps and requires a password change
    /// </summary>
    /// <param name="userId">The account whose password is being reset</param>
    /// <param name="request">The replacement temporary password</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>The reset result, including validation failures or a missing account</returns>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<IdentityResult> ResetPasswordAsync(
        Guid userId,
        ResetAccountPasswordRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request is null || !IsValidPassword(request.NewTemporaryPassword))
        {
            return Failure("InvalidInput");
        }

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var user = await users.FindByIdAsync(userId.ToString("D"));
        if (user is null)
        {
            return Failure("UserNotFound");
        }

        cancellationToken.ThrowIfCancellationRequested();
        user.MustChangePassword = true;
        var token = await users.GeneratePasswordResetTokenAsync(user);
        cancellationToken.ThrowIfCancellationRequested();
        var result = await users.ResetPasswordAsync(user, token, request.NewTemporaryPassword);
        if (!result.Succeeded)
        {
            return result;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await transaction.CommitAsync(cancellationToken);
        return IdentityResult.Success;
    }

    private async Task<(IdentityResult Result, ProvisionedAccount? Account)> ProvisionCoreAsync(
        ProvisionAccountRequest request,
        CancellationToken cancellationToken)
    {
        var roleId = request.Role switch
        {
            ApplicationRoles.Administrator => ApplicationRoles.AdministratorId,
            ApplicationRoles.Educator => ApplicationRoles.EducatorId,
            _ => ApplicationRoles.CreatorId,
        };
        var normalizedRole = users.NormalizeName(request.Role);
        if (!await database.Roles.AnyAsync(role => role.Id == roleId && role.Name == request.Role
            && role.NormalizedName == normalizedRole, cancellationToken))
        {
            throw new InvalidOperationException("The fixed account roles are unavailable.");
        }

        if (request.OrgId is { } organizationId
            && !await database.Organizations.AnyAsync(organization => organization.Id == organizationId && organization.IsActive,
                cancellationToken))
        {
            return (Failure("OrganizationUnavailable"), null);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var user = new ApplicationUser { UserName = request.UserName };
        var created = await users.CreateAsync(user, request.InitialPassword);
        if (!created.Succeeded)
        {
            return (created, null);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var assigned = await users.AddToRoleAsync(user, request.Role);
        if (!assigned.Succeeded)
        {
            return (assigned, null);
        }

        if (request.OrgId is { } orgId)
        {
            cancellationToken.ThrowIfCancellationRequested();
            database.OrganizationMemberships.Add(new OrganizationMembership
            {
                OrganizationId = orgId,
                UserId = user.Id,
                RoleId = roleId,
            });
            await database.SaveChangesAsync(cancellationToken);
        }

        return (IdentityResult.Success, new ProvisionedAccount(user.Id, request.UserName, request.Role,
            request.OrgId, user.IsActive, user.MustChangePassword));
    }

    private static bool IsValidAccount(ProvisionAccountRequest? request)
        => request is not null && IsValidName(request.UserName) && IsValidPassword(request.InitialPassword)
            && (request.Role == ApplicationRoles.Administrator
                ? request.OrgId is null
                : (request.Role == ApplicationRoles.Educator || request.Role == ApplicationRoles.Creator)
                    && request.OrgId is { } orgId && orgId != Guid.Empty);

    private static bool IsValidName(string? name)
        => name is { Length: > 0 and <= 256 } && !string.IsNullOrWhiteSpace(name);

    private static bool IsValidPassword(string? password) => password is { Length: >= 12 and <= 128 };

    private static bool IsDuplicateUserName(DbUpdateException exception)
        => exception.InnerException is PostgresException
        {
            SqlState: PostgresErrorCodes.UniqueViolation,
            ConstraintName: "UserNameIndex",
        };

    private static IdentityResult Failure(string code)
        => IdentityResult.Failed(new IdentityError { Code = code, Description = "The account operation could not be completed." });
}
