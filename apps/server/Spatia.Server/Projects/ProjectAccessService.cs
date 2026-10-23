using System.Collections.Immutable;
using System.Data;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Options;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>
/// Revalidates account authority and project permissions within database snapshot or locking transactions
/// </summary>
/// <param name="database">The scoped context used for project reads and locks</param>
/// <param name="accounts">The account resolver sharing the same database context</param>
/// <param name="identityOptions">The Identity options defining the claims bound to the validated session</param>
public sealed class ProjectAccessService(
    ApplicationDbContext database,
    CurrentAccountResolver accounts,
    IOptions<IdentityOptions> identityOptions)
{
    /// <summary>
    /// Reads current account authority and project data in one repeatable-read snapshot
    /// </summary>
    /// <param name="context">The authenticated request carrying a validated account session</param>
    /// <param name="projectId">The project whose current draft and permissions are requested</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>An authorized snapshot, or a denial that conceals inaccessible projects as not found</returns>
    /// <remarks>
    /// TODO: Integrate SCRUM-50 validation and reconstruction before consumers interpret returned project JSON
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="context"/> is null</exception>
    /// <exception cref="InvalidOperationException">The context already has a transaction</exception>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<ProjectAccessResult> ReadAsync(
        HttpContext context,
        Guid projectId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (database.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException("Project reads require ownership of their snapshot transaction.");
        }

        var session = GetSession(context);
        if (session is null)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        if (HasExpired(session))
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }

        var account = await accounts.ResolveAsync(session.UserId, session.SecurityStamp, cancellationToken);
        if (HasExpired(session) || account is null)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }
        if (account.MustChangePassword)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.PasswordChangeRequired);
        }

        var snapshot = await ReadSnapshotAsync(account, projectId, cancellationToken);
        if (HasExpired(session))
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }
        if (snapshot is null)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.NotFound);
        }

        await transaction.CommitAsync(cancellationToken);
        if (HasExpired(session))
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }

        // TODO: Apply SCRUM-50 validation and reconstruction before this snapshot is consumed as authored project content
        return ProjectAccessResult.Granted(snapshot);
    }

    /// <summary>
    /// Locks and reauthorizes a project within the caller's read-committed transaction
    /// </summary>
    /// <param name="context">The authenticated request carrying a validated account session</param>
    /// <param name="projectId">The project to lock for the requested operation</param>
    /// <param name="purpose">The operation whose permissions and archive restrictions must be checked</param>
    /// <param name="cancellationToken">The token used to cancel lock acquisition and database work</param>
    /// <returns>The authorized locked snapshot, or the reason access to the operation was denied</returns>
    /// <remarks>
    /// The caller must retain and dispose its transaction on every result, including denial
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="context"/> is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="purpose"/> is not a defined lock purpose
    /// </exception>
    /// <exception cref="InvalidOperationException">A caller-owned read-committed transaction is not active</exception>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<ProjectAccessResult> LockAsync(
        HttpContext context,
        Guid projectId,
        ProjectLockPurpose purpose,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (!Enum.IsDefined(purpose))
        {
            throw new ArgumentOutOfRangeException(nameof(purpose));
        }

        var transaction = database.Database.CurrentTransaction;
        if (transaction is null || transaction.GetDbTransaction().IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw new InvalidOperationException("Project locks require a caller-owned read-committed transaction.");
        }

        var session = GetSession(context);
        if (session is null)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }

        var lockedIds = await database.Database.SqlQuery<Guid>(
            $"SELECT id AS \"Value\" FROM projects WHERE id = {projectId} FOR UPDATE").ToListAsync(cancellationToken);
        if (HasExpired(session))
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }

        var account = await accounts.ResolveAsync(session.UserId, session.SecurityStamp, cancellationToken);
        if (HasExpired(session) || account is null)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }
        if (account.MustChangePassword)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.PasswordChangeRequired);
        }
        if (lockedIds.Count == 0)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.NotFound);
        }

        var snapshot = await ReadSnapshotAsync(account, projectId, cancellationToken);
        if (HasExpired(session))
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.AuthenticationRequired);
        }
        if (snapshot is null)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.NotFound);
        }
        if (purpose != ProjectLockPurpose.EditDraft && !snapshot.CanManage)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.OperationForbidden);
        }
        if (purpose != ProjectLockPurpose.ChangeArchiveState && snapshot.IsArchived)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.ProjectReadOnly);
        }
        if (purpose == ProjectLockPurpose.EditDraft && !snapshot.CanEdit)
        {
            return ProjectAccessResult.Denied(ProjectAccessFailure.OperationForbidden);
        }

        // TODO: Require SCRUM-50-accepted document input when Part 5 consumes an EditDraft lock for content writes
        return ProjectAccessResult.Granted(snapshot);
    }

    private ValidatedAccountSession? GetSession(HttpContext context)
    {
        var session = context.Features.Get<ValidatedAccountSession>();
        if (session is null || context.User.Identity?.IsAuthenticated != true || HasExpired(session))
        {
            return null;
        }

        var claims = identityOptions.Value.ClaimsIdentity;
        var userIds = context.User.FindAll(claims.UserIdClaimType).ToArray();
        var stamps = context.User.FindAll(claims.SecurityStampClaimType).ToArray();
        return userIds.Length == 1 && userIds[0].Value.Length == 36
            && Guid.TryParseExact(userIds[0].Value, "D", out var userId) && userId == session.UserId
            && stamps.Length == 1 && string.Equals(stamps[0].Value, session.SecurityStamp, StringComparison.Ordinal)
            ? session : null;
    }

    private async Task<ProjectAccessSnapshot?> ReadSnapshotAsync(
        CurrentAccount account,
        Guid projectId,
        CancellationToken cancellationToken)
    {
        var projects = database.Projects.AsNoTracking().Where(project => project.Id == projectId);
        projects = account.Role switch
        {
            ApplicationRoles.Administrator => projects,
            ApplicationRoles.Educator => projects.Where(project => project.OrganizationId == account.OrganizationId
                && database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                    && assignment.UserId == account.UserId && assignment.CanManage)),
            ApplicationRoles.Creator => projects.Where(project => project.OrganizationId == account.OrganizationId
                && database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                    && assignment.UserId == account.UserId && assignment.CanEdit)),
            _ => projects.Where(_ => false),
        };

        var row = await projects.Select(project => new
        {
            Project = project,
            CanPublish = account.Role != ApplicationRoles.Creator
                || database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                    && assignment.UserId == account.UserId && assignment.CanPublish),
        }).SingleOrDefaultAsync(cancellationToken);
        if (row is null)
        {
            return null;
        }

        var project = row.Project;
        // TODO: Keep this JSON unvalidated until SCRUM-50 validates and reconstructs its supported authored content
        return new ProjectAccessSnapshot(
            account.UserId, project.Id, project.OrganizationId, project.IsArchived, project.Revision,
            project.SchemaVersion, project.DocumentJson, project.UpdatedAt, project.LastMutationActorId,
            project.LastMutationId,
            project.LastMutationDigest is { } digest ? ImmutableArray.CreateRange(digest) : null,
            !project.IsArchived, account.Role != ApplicationRoles.Creator, !project.IsArchived && row.CanPublish);
    }

    private static bool HasExpired(ValidatedAccountSession session) => session.Clock.GetUtcNow() >= session.ExpiresUtc;
}
