using System.Data;
using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Classes;

/// <summary>Maps authorized class and roster operations.</summary>
public static class ClassroomEndpoints
{
    /// <summary>Adds bounded class reads and organization-scoped roster writes.</summary>
    public static IEndpointRouteBuilder MapClassrooms(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/classes").RequireAuthorization(SecurityPolicies.FullAccount);
        group.MapGet("", ListAsync);
        group.MapGet("/{id:guid}", GetAsync);
        group.MapGet("/{id:guid}/roster", RosterAsync);
        group.MapGet("/{id:guid}/eligible-students", EligibleStudentsAsync);
        group.MapGet("/{id:guid}/assignments", ClassAssignmentReads.ListAsync);
        group.MapGet("/{id:guid}/assignments/{assignmentId:guid}", ClassAssignmentReads.GetAsync);
        group.MapPost("/", CreateAsync).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapPost("/{id:guid}/assignments", ClassAssignmentCoordinator.CreateAsync)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapPut("/{id:guid}/members/{userId:guid}", AddMemberAsync).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapDelete("/{id:guid}/members/{userId:guid}", RemoveMemberAsync).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        return endpoints;
    }

    private static async Task<IResult> CreateAsync(CreateClassroomRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        var managers = request.ManagedByUserIds ?? [];
        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 256 || request.Name.Contains('\0')
            || managers.Length > 100 || managers.Contains(Guid.Empty) || managers.Distinct().Count() != managers.Length)
        {
            return InvalidInput(context);
        }

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (AccountFailure(context, account) is { } failure) { return failure; }
        if (account!.Role is not (ApplicationRoles.Administrator or ApplicationRoles.Educator))
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        if (account.OrganizationId is { } own && request.OrgId is { } requested && own != requested)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        var organizationId = account.OrganizationId ?? request.OrgId;
        if (organizationId is null || !await database.Organizations.AnyAsync(row => row.Id == organizationId && row.IsActive, cancellationToken))
        {
            return ApiProblems.Create(context, 422, "organization_unavailable", "Choose an active organization.");
        }
        var managerIds = managers.ToHashSet();
        if (account.Role == ApplicationRoles.Educator) { managerIds.Add(account.UserId); }
        if (managerIds.Count > 100 || await EligibleManagerCountAsync(database, organizationId.Value, managerIds, cancellationToken) != managerIds.Count)
        {
            return InvalidMembers(context);
        }
        var classroom = new Classroom { Id = Guid.NewGuid(), OrganizationId = organizationId.Value, Name = request.Name };
        database.Classrooms.Add(classroom);
        database.ClassroomMembers.AddRange(managerIds.Select(userId => new ClassroomMember
        {
            ClassroomId = classroom.Id,
            OrganizationId = classroom.OrganizationId,
            UserId = userId,
            RoleId = ApplicationRoles.EducatorId,
        }));
        await database.SaveChangesAsync(cancellationToken);
        return await CompleteAsync(context, transaction, Results.Json(new { id = classroom.Id, classroom.OrganizationId, classroom.Name }, statusCode: 201), cancellationToken);
    }

    private static async Task<IResult> ListAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!TryPage(context, out var limit, out var cursor)) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (AccountFailure(context, account) is { } failure) { return failure; }
        var roleId = account!.Role == ApplicationRoles.Educator ? ApplicationRoles.EducatorId : ApplicationRoles.CreatorId;
        var query = database.Classrooms.AsNoTracking().Where(row => account.Role == ApplicationRoles.Administrator
            || (row.OrganizationId == account.OrganizationId && database.ClassroomMembers.Any(member => member.ClassroomId == row.Id
                && member.UserId == account.UserId && member.RoleId == roleId && member.IsActive)));
        if (cursor is { } after) { query = query.Where(row => row.Id.CompareTo(after) > 0); }
        var rows = await query.OrderBy(row => row.Id).Take(limit + 1).Select(row => new { id = row.Id, row.OrganizationId, row.Name })
            .ToListAsync(cancellationToken);
        var nextCursor = rows.Count > limit ? rows[limit - 1].id : (Guid?)null;
        return await CompleteAsync(context, transaction, Results.Ok(new { items = rows.Take(limit).ToArray(), nextCursor }), cancellationToken);
    }

    private static async Task<IResult> GetAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var (classroom, failure) = await FindAsync(id, context, database, access, false, false, cancellationToken);
        if (failure is not null) { return failure; }
        return await CompleteAsync(context, transaction,
            Results.Ok(new { id = classroom!.Id, classroom.OrganizationId, classroom.Name }), cancellationToken);
    }

    private static async Task<IResult> RosterAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!TryPage(context, out var limit, out var cursor)) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var (_, failure) = await FindAsync(id, context, database, access, true, false, cancellationToken);
        if (failure is not null) { return failure; }
        var query = from member in database.ClassroomMembers.AsNoTracking()
                    join user in database.Users.AsNoTracking() on member.UserId equals user.Id
                    where member.ClassroomId == id && member.IsActive
                    select new { userId = user.Id, user.UserName, member.RoleId, accountActive = user.IsActive };
        if (cursor is { } after) { query = query.Where(row => row.userId.CompareTo(after) > 0); }
        var rows = await query.OrderBy(row => row.userId).Take(limit + 1).ToListAsync(cancellationToken);
        var nextCursor = rows.Count > limit ? rows[limit - 1].userId : (Guid?)null;
        return await CompleteAsync(context, transaction, Results.Ok(new { items = rows.Take(limit).ToArray(), nextCursor }), cancellationToken);
    }

    private static async Task<IResult> EligibleStudentsAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!TryPage(context, out var limit, out var cursor)) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var (classroom, failure) = await FindAsync(id, context, database, access, true, false, cancellationToken);
        if (failure is not null) { return failure; }
        var query = from membership in database.OrganizationMemberships.AsNoTracking()
                    join user in database.Users.AsNoTracking() on membership.UserId equals user.Id
                    join organization in database.Organizations.AsNoTracking() on membership.OrganizationId equals organization.Id
                    join role in database.Roles.AsNoTracking() on membership.RoleId equals role.Id
                    where membership.OrganizationId == classroom!.OrganizationId && organization.IsActive
                        && membership.RoleId == ApplicationRoles.CreatorId && role.Name == ApplicationRoles.Creator && user.IsActive
                    select new
                    {
                        userId = user.Id,
                        user.UserName,
                        enrolled = database.ClassroomMembers.Any(row => row.ClassroomId == id && row.UserId == user.Id && row.IsActive),
                    };
        if (cursor is { } after) { query = query.Where(row => row.userId.CompareTo(after) > 0); }
        var rows = await query.OrderBy(row => row.userId).Take(limit + 1).ToListAsync(cancellationToken);
        var nextCursor = rows.Count > limit ? rows[limit - 1].userId : (Guid?)null;
        return await CompleteAsync(context, transaction, Results.Ok(new { items = rows.Take(limit).ToArray(), nextCursor }), cancellationToken);
    }

    private static Task<IResult> AddMemberAsync(Guid id, Guid userId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken) =>
        ChangeMemberAsync(id, userId, context, database, access, true, cancellationToken);

    private static Task<IResult> RemoveMemberAsync(Guid id, Guid userId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken) =>
        ChangeMemberAsync(id, userId, context, database, access, false, cancellationToken);

    private static async Task<IResult> ChangeMemberAsync(Guid id, Guid userId, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, bool add, CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty) { return InvalidInput(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var (classroom, failure) = await FindAsync(id, context, database, access, true, true, cancellationToken);
        if (failure is not null) { return failure; }
        var member = await database.ClassroomMembers.SingleOrDefaultAsync(row => row.ClassroomId == id && row.UserId == userId, cancellationToken);
        if (add)
        {
            var roleId = await EligibleRoleAsync(database, classroom!.OrganizationId, userId, cancellationToken);
            if (roleId is null) { return InvalidMembers(context); }
            if (member is null)
            {
                database.ClassroomMembers.Add(new ClassroomMember
                {
                    ClassroomId = id,
                    OrganizationId = classroom.OrganizationId,
                    UserId = userId,
                    RoleId = roleId.Value,
                });
            }
            else { member.IsActive = true; }
        }
        else if (member is { IsActive: true })
        {
            var allProjects = member.RoleId == ApplicationRoles.EducatorId;
            // Class then project locks serialize removals with already-authorized project writes.
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                SELECT p.id FROM projects p
                JOIN class_assignment_students s ON s.project_id = p.id
                WHERE s.classroom_id = {id} AND ({allProjects} OR s.student_id = {userId})
                ORDER BY p.id FOR UPDATE OF p
                """, cancellationToken);
            var (_, reauthorizationFailure) = await FindAsync(id, context, database, access, true, false, cancellationToken);
            if (reauthorizationFailure is not null) { return reauthorizationFailure; }
            member.IsActive = false;
        }
        await database.SaveChangesAsync(cancellationToken);
        return await CompleteAsync(context, transaction, Results.NoContent(), cancellationToken);
    }

    internal static async Task<(Classroom? Classroom, IResult? Failure)> FindAsync(Guid id, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, bool managerOnly, bool lockRow, CancellationToken cancellationToken)
    {
        if (lockRow)
        {
            await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM classrooms WHERE id = {id} FOR UPDATE")
                .ToListAsync(cancellationToken);
        }
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (AccountFailure(context, account) is { } failure) { return (null, failure); }
        var classroom = await database.Classrooms.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id, cancellationToken);
        if (classroom is null) { return (null, NotFound(context)); }
        if (account!.Role == ApplicationRoles.Administrator) { return (classroom, null); }
        var roleId = account.Role == ApplicationRoles.Educator ? ApplicationRoles.EducatorId : ApplicationRoles.CreatorId;
        if (classroom.OrganizationId != account.OrganizationId || (managerOnly && account.Role != ApplicationRoles.Educator)
            || !await database.ClassroomMembers.AnyAsync(row => row.ClassroomId == id && row.UserId == account.UserId
                && row.RoleId == roleId && row.IsActive, cancellationToken))
        {
            return (null, NotFound(context));
        }
        return (classroom, null);
    }

    private static Task<int> EligibleManagerCountAsync(ApplicationDbContext database, Guid organizationId,
        HashSet<Guid> ids, CancellationToken cancellationToken) =>
        (from membership in database.OrganizationMemberships
         join user in database.Users on membership.UserId equals user.Id
         join role in database.Roles on membership.RoleId equals role.Id
         where membership.OrganizationId == organizationId && ids.Contains(user.Id) && user.IsActive
             && membership.RoleId == ApplicationRoles.EducatorId && role.Name == ApplicationRoles.Educator
         select user.Id).CountAsync(cancellationToken);

    private static async Task<Guid?> EligibleRoleAsync(ApplicationDbContext database, Guid organizationId, Guid userId,
        CancellationToken cancellationToken) =>
        await (from membership in database.OrganizationMemberships
               join user in database.Users on membership.UserId equals user.Id
               join organization in database.Organizations on membership.OrganizationId equals organization.Id
               join role in database.Roles on membership.RoleId equals role.Id
               where membership.OrganizationId == organizationId && organization.IsActive && user.Id == userId && user.IsActive
                   && ((membership.RoleId == ApplicationRoles.EducatorId && role.Name == ApplicationRoles.Educator)
                       || (membership.RoleId == ApplicationRoles.CreatorId && role.Name == ApplicationRoles.Creator))
               select (Guid?)membership.RoleId).SingleOrDefaultAsync(cancellationToken);

    internal static bool TryPage(HttpContext context, out int limit, out Guid? cursor)
    {
        limit = 10;
        cursor = null;
        var query = context.Request.Query;
        if (query.Any(pair => pair.Value.Count != 1 || pair.Key is not ("limit" or "cursor"))
            || (query.TryGetValue("limit", out var rawLimit)
                && (!int.TryParse(rawLimit, NumberStyles.None, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 20)))
        {
            return false;
        }
        if (query.TryGetValue("cursor", out var rawCursor))
        {
            if (rawCursor[0]?.Length != 36 || !Guid.TryParseExact(rawCursor[0], "D", out var id)) { return false; }
            cursor = id;
        }
        return true;
    }

    internal static async Task<IResult> CompleteAsync(HttpContext context, IDbContextTransaction transaction, IResult result,
        CancellationToken cancellationToken)
    {
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        context.Response.Headers.CacheControl = "no-store";
        return result;
    }

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
    private static IResult? AccountFailure(HttpContext context, CurrentAccount? account) => account is null
        ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired)
        : account.MustChangePassword ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired) : null;
    private static IResult NotFound(HttpContext context) => ApiProblems.Create(context, 404, "class_not_found", "The class is unavailable.");
    private static IResult InvalidInput(HttpContext context) => ApiProblems.Create(context, 400, "invalid_class_input", "Check the class details.");
    private static IResult InvalidMembers(HttpContext context) => ApiProblems.Create(context, 422, "invalid_class_members", "Choose active accounts in this organization.");
    internal static IResult InvalidQuery(HttpContext context) => ApiProblems.Create(context, 400, "invalid_class_query", "Check the class list filters and cursor.");

    private sealed record CreateClassroomRequest(string? Name, Guid? OrgId, Guid[]? ManagedByUserIds);
}
