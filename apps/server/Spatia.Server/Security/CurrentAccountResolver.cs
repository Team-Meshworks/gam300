using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Security;

/// <summary>
/// Resolves active account authority from current credentials, roles and organization membership
/// </summary>
/// <param name="database">The scoped context used to read account and organization state</param>
public sealed class CurrentAccountResolver(ApplicationDbContext database)
{
    /// <summary>
    /// Accepts an account only when its security stamp, fixed role and required organization membership remain valid
    /// </summary>
    /// <param name="userId">The account identifier from the authenticated credentials</param>
    /// <param name="expectedStamp">The security stamp that must still match the stored account</param>
    /// <param name="cancellationToken">The token used to cancel the database query</param>
    /// <returns>
    /// The current account authority, or null when the account is unavailable or its authority is invalid
    /// </returns>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<CurrentAccount?> ResolveAsync(
        Guid userId,
        string expectedStamp,
        CancellationToken cancellationToken = default)
    {
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
            }).SingleOrDefaultAsync(cancellationToken);

        if (current is null || !current.IsActive || string.IsNullOrEmpty(current.UserName)
            || current.SecurityStamp != expectedStamp)
        {
            return null;
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
            return null;
        }

        return new CurrentAccount(userId, current.UserName, role, current.OrganizationId, current.MustChangePassword);
    }
}
