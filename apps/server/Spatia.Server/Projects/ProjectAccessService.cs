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
    /// Consumers must reconstruct returned JSON through ProjectDocumentService before reading authored content
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

        return ProjectAccessResult.Granted(snapshot);
    }

    /// <summary>
    /// Reads one bounded page under the same current-account and assignment snapshot as individual opens
    /// </summary>
    /// <remarks>
    /// The cursor is only an exclusive UUID position, never authority; every page filters current visibility
    /// Consumers must validate stored content and expose only public summaries
    /// </remarks>
    public async Task<ProjectListAccessResult> ListAsync(HttpContext context, Guid? cursor, int limit, bool archived,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (limit is < 1 or > 20)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }
        if (database.Database.CurrentTransaction is not null)
        {
            throw new InvalidOperationException("Project lists require ownership of their snapshot transaction.");
        }
        var session = GetSession(context);
        if (session is null)
        {
            return new([], null, ProjectAccessFailure.AuthenticationRequired);
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var account = await accounts.ResolveAsync(session.UserId, session.SecurityStamp, cancellationToken);
        if (HasExpired(session) || account is null)
        {
            return new([], null, ProjectAccessFailure.AuthenticationRequired);
        }
        if (account.MustChangePassword)
        {
            return new([], null, ProjectAccessFailure.PasswordChangeRequired);
        }

        var query = VisibleProjects(account).Where(project => project.IsArchived == archived);
        if (cursor is { } after)
        {
            query = query.Where(project => project.Id.CompareTo(after) > 0);
        }
        // Read one extra ID, not an extra potentially large document, to determine whether another page exists
        var ids = await query.OrderBy(project => project.Id).Select(project => project.Id).Take(limit + 1)
            .ToListAsync(cancellationToken);
        var pageIds = ids.Take(limit).ToArray();
        var rows = await VisibleProjects(account).Where(project => pageIds.Contains(project.Id)).OrderBy(project => project.Id)
            .Select(project => new
            {
                Project = project,
                CanPublish = account.Role != ApplicationRoles.Creator
                    || database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                        && assignment.UserId == account.UserId && assignment.CanPublish),
            }).ToListAsync(cancellationToken);
        if (HasExpired(session))
        {
            return new([], null, ProjectAccessFailure.AuthenticationRequired);
        }
        await transaction.CommitAsync(cancellationToken);
        return HasExpired(session)
            ? new([], null, ProjectAccessFailure.AuthenticationRequired)
            : new(rows.Select(row => Snapshot(account, row.Project, row.CanPublish)).ToArray(),
                ids.Count > limit ? pageIds[^1] : null, null);
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

        return ProjectAccessResult.Granted(snapshot);
    }

    internal async Task<CurrentAccount?> ResolveCurrentAccountAsync(HttpContext context, CancellationToken cancellationToken)
    {
        var session = GetSession(context);
        if (session is null) { return null; }
        var account = await accounts.ResolveAsync(session.UserId, session.SecurityStamp, cancellationToken);
        return HasExpired(session) ? null : account;
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
        var row = await VisibleProjects(account).Where(project => project.Id == projectId).Select(project => new
        {
            Project = project,
            CanPublish = account.Role != ApplicationRoles.Creator
                || database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                    && assignment.UserId == account.UserId && assignment.CanPublish),
        }).SingleOrDefaultAsync(cancellationToken);
        return row is null ? null : Snapshot(account, row.Project, row.CanPublish);
    }

    private IQueryable<Project> VisibleProjects(CurrentAccount account)
    {
        var projects = database.Projects.AsNoTracking();
        return account.Role switch
        {
            ApplicationRoles.Administrator => projects,
            ApplicationRoles.Educator => projects.Where(project => project.OrganizationId == account.OrganizationId
                && database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                    && assignment.UserId == account.UserId && assignment.CanManage)
                && (!database.ClassAssignmentStudents.Any(mapping => mapping.ProjectId == project.Id)
                    || database.ClassAssignmentStudents.Any(mapping => mapping.ProjectId == project.Id
                        && database.ClassroomMembers.Any(member => member.ClassroomId == mapping.ClassroomId
                            && member.UserId == account.UserId && member.RoleId == ApplicationRoles.EducatorId && member.IsActive)))),
            ApplicationRoles.Creator => projects.Where(project => project.OrganizationId == account.OrganizationId
                && database.ProjectAssignments.Any(assignment => assignment.ProjectId == project.Id
                    && assignment.UserId == account.UserId && assignment.CanEdit)
                && (!database.ClassAssignmentStudents.Any(mapping => mapping.ProjectId == project.Id)
                    || database.ClassAssignmentStudents.Any(mapping => mapping.ProjectId == project.Id
                        && mapping.StudentId == account.UserId
                        && database.ClassroomMembers.Any(member => member.ClassroomId == mapping.ClassroomId
                            && member.UserId == account.UserId && member.RoleId == ApplicationRoles.CreatorId && member.IsActive)))),
            _ => projects.Where(_ => false),
        };
    }

    private static ProjectAccessSnapshot Snapshot(CurrentAccount account, Project project, bool canPublish)
    {
        // Access snapshots retain private raw storage; consumers reconstruct content through ProjectDocumentService
        return new ProjectAccessSnapshot(
            account.UserId, project.Id, project.OrganizationId, project.IsArchived, project.Revision,
            project.SchemaVersion, project.DocumentJson, project.UpdatedAt, project.LastMutationActorId,
            project.LastMutationId,
            project.LastMutationDigest is { } digest ? ImmutableArray.CreateRange(digest) : null,
            !project.IsArchived, account.Role != ApplicationRoles.Creator, !project.IsArchived && canPublish);
    }

    private static bool HasExpired(ValidatedAccountSession session) => session.Clock.GetUtcNow() >= session.ExpiresUtc;
}
