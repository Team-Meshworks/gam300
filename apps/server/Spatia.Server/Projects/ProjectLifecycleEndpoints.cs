using System.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.ProjectFormat;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>Maps creation and the revisioned project lifecycle under the shared authorization and locking policy</summary>
public static class ProjectLifecycleEndpoints
{
    /// <summary>Adds protected create, duplicate, assignment and archive/reopen routes</summary>
    public static IEndpointRouteBuilder MapProjectLifecycle(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/projects").RequireAuthorization(SecurityPolicies.FullAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        group.MapPost("/", CreateAsync).WithMetadata(new RequestSizeLimitAttribute(SaveEnvelopeReader.MaxRequestBytes));
        group.MapPost("/{id:guid}/duplicate", DuplicateAsync);
        group.MapPatch("/{id:guid}/assignments", AssignAsync);
        group.MapPatch("/{id:guid}/archive", ArchiveAsync);
        return endpoints;
    }

    private static async Task<IResult> CreateAsync(CreateProjectRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents, CancellationToken cancellationToken)
    {
        if (!ValidTitle(request.Title) || (request.Document is not null && request.EnvironmentAssetId is not null))
        {
            return InvalidInput(context);
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (AccountFailure(context, account) is { } failure) { return failure; }
        var organizationId = account!.OrganizationId ?? request.OrgId;
        if (account.OrganizationId is { } ownOrganization && request.OrgId is { } requested && requested != ownOrganization)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        if (organizationId is null || !await database.Organizations.AnyAsync(row => row.Id == organizationId && row.IsActive, cancellationToken))
        {
            return ApiProblems.Create(context, 422, "organization_unavailable", "Choose an active organization.");
        }
        var id = Guid.NewGuid();
        IAuthoredProject document;
        if (request.Document is { } imported)
        {
            var parsed = documents.Read(imported.GetRawText());
            if (!parsed.Ok) { return InvalidDocument(context); }
            document = Copy(parsed.Value!, id, request.Title);
        }
        else if (request.EnvironmentAssetId is null)
        {
            document = new ContentProject(2, id.ToString("D"), request.Title,
                [new ContentScene(Guid.NewGuid().ToString("D"), "Scene", null,
                    new CameraPose([12, 16, 18], [-0.29962059992658957, 0.2752183320355054, 0.09071781822041597, 0.9089844021041025], 40),
                    [], [], [], [], [], [], [])]);
        }
        else
        {
            document = new LegacyProject(1, id.ToString("D"), request.Title,
                [new LegacyScene(Guid.NewGuid().ToString("D"), "Room", request.EnvironmentAssetId!,
                    new CameraPose([12, 16, 18], [-0.29962059992658957, 0.2752183320355054, 0.09071781822041597, 0.9089844021041025], 40), [], [], [])]);
            // Fresh drafts follow import retirement checks; retained-reference serialization stays unchanged.
            var serialized = documents.Serialize(document);
            if (!serialized.Ok || !documents.Read(serialized.Value!).Ok) { return InvalidDocument(context); }
        }
        return await InsertAsync(context, database, documents, transaction, account, organizationId.Value, document, cancellationToken);
    }

    private static async Task<IResult> DuplicateAsync(Guid id, DuplicateProjectRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents, CancellationToken cancellationToken)
    {
        if (!ValidRevision(request.ExpectedRevision) || !ValidTitle(request.Title)) { return InvalidInput(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, id, ProjectLockPurpose.EditDraft, cancellationToken);
        if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var source = authorization.Snapshot!;
        if (request.ExpectedRevision != source.Revision) { return RevisionProblem(context, source.Revision); }
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (AccountFailure(context, account) is { } accountFailure) { return accountFailure; }
        if (account!.OrganizationId is { } organizationId && organizationId != source.OrganizationId)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound);
        }
        var parsed = documents.ReadStored(id, source.SchemaVersion, source.UnvalidatedDocumentJson);
        if (!parsed.Ok) { return ApiProblems.Create(context, 503, "project_unavailable", "The project is unavailable."); }
        return await InsertAsync(context, database, documents, transaction, account, source.OrganizationId,
            Copy(parsed.Value!, Guid.NewGuid(), request.Title), cancellationToken);
    }

    private static async Task<IResult> AssignAsync(Guid id, ProjectAssignmentsRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!ValidRevision(request.ExpectedRevision) || !ValidIds(request.ManagedByUserIds) || !ValidIds(request.AssignedCreatorIds)
            || !ValidIds(request.CanPublishUserIds) || request.ManagedByUserIds.Intersect(request.AssignedCreatorIds).Any()
            || request.CanPublishUserIds.Except(request.AssignedCreatorIds).Any()) { return InvalidInput(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, id, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var project = authorization.Snapshot!;
        if (request.ExpectedRevision != project.Revision || project.Revision == Project.MaxRevision)
        {
            return RevisionProblem(context, project.Revision, request.ExpectedRevision == project.Revision);
        }
        var originalStudent = await database.ClassAssignmentStudents.Where(row => row.ProjectId == id)
            .Select(row => (Guid?)row.StudentId).SingleOrDefaultAsync(cancellationToken);
        if (originalStudent is { } studentId && request.AssignedCreatorIds.Any(userId => userId != studentId))
        {
            return ApiProblems.Create(context, 422, "invalid_project_assignments", "A class draft can only be assigned to its original student.");
        }
        var ids = request.ManagedByUserIds.Concat(request.AssignedCreatorIds).ToArray();
        var eligible = await (from membership in database.OrganizationMemberships
                              join user in database.Users on membership.UserId equals user.Id
                              join role in database.Roles on membership.RoleId equals role.Id
                              join organization in database.Organizations on membership.OrganizationId equals organization.Id
                              where ids.Contains(user.Id) && user.IsActive && organization.IsActive && organization.Id == project.OrganizationId
                                  && ((role.Id == ApplicationRoles.EducatorId && role.Name == ApplicationRoles.Educator)
                                      || (role.Id == ApplicationRoles.CreatorId && role.Name == ApplicationRoles.Creator))
                              select new { user.Id, role.Name }).ToListAsync(cancellationToken);
        if (request.ManagedByUserIds.Any(userId => !eligible.Any(row => row.Id == userId && row.Name == ApplicationRoles.Educator))
            || request.AssignedCreatorIds.Any(userId => !eligible.Any(row => row.Id == userId && row.Name == ApplicationRoles.Creator)))
        {
            return ApiProblems.Create(context, 422, "invalid_project_assignments", "Choose active accounts with the required role in this organization.");
        }
        await database.ProjectAssignments.Where(row => row.ProjectId == id).ExecuteDeleteAsync(cancellationToken);
        database.ProjectAssignments.AddRange(ids.Select(userId => new ProjectAssignment
        {
            ProjectId = id,
            UserId = userId,
            CanEdit = true,
            CanManage = request.ManagedByUserIds.Contains(userId),
            CanPublish = request.ManagedByUserIds.Contains(userId) || request.CanPublishUserIds.Contains(userId)
        }));
        await database.SaveChangesAsync(cancellationToken);
        await AdvanceAsync(database, project, project.IsArchived, cancellationToken);
        return await CommitAsync(context, database, transaction, id, false, cancellationToken);
    }

    private static async Task<IResult> ArchiveAsync(Guid id, ProjectArchiveRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!ValidRevision(request.ExpectedRevision)) { return InvalidInput(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var authorization = await access.LockAsync(context, id, ProjectLockPurpose.ChangeArchiveState, cancellationToken);
        if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        var project = authorization.Snapshot!;
        if (request.ExpectedRevision != project.Revision || project.Revision == Project.MaxRevision)
        {
            return RevisionProblem(context, project.Revision, request.ExpectedRevision == project.Revision);
        }
        await AdvanceAsync(database, project, request.Archived, cancellationToken);
        return await CommitAsync(context, database, transaction, id, false, cancellationToken);
    }

    private static async Task<IResult> InsertAsync(HttpContext context, ApplicationDbContext database, ProjectDocumentService documents,
        IDbContextTransaction transaction, CurrentAccount account, Guid organizationId, IAuthoredProject document, CancellationToken cancellationToken)
    {
        var id = Guid.Parse(document.ProjectId);
        var assignments = account.Role == ApplicationRoles.Administrator ? Array.Empty<ProjectAssignment>() :
            [new ProjectAssignment
            {
                ProjectId = id,
                UserId = account.UserId,
                CanEdit = true,
                CanManage = account.Role == ApplicationRoles.Educator,
                CanPublish = account.Role == ApplicationRoles.Educator,
            }];
        if (!StageDraft(database, documents, organizationId, document, assignments)) { return InvalidDocument(context); }
        await database.SaveChangesAsync(cancellationToken);
        return await CommitAsync(context, database, transaction, id, true, cancellationToken);
    }

    internal static bool StageDraft(ApplicationDbContext database, ProjectDocumentService documents, Guid organizationId,
        IAuthoredProject document, IReadOnlyCollection<ProjectAssignment> assignments)
    {
        if (database.Database.CurrentTransaction?.GetDbTransaction().IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw new InvalidOperationException("Project creation requires a caller-owned read-committed transaction.");
        }
        var serialized = documents.Serialize(document);
        if (!serialized.Ok) { return false; }
        var id = Guid.Parse(document.ProjectId);
        if (assignments.Any(assignment => assignment.ProjectId != id || assignment.UserId == Guid.Empty))
        {
            throw new ArgumentException("Project assignments must refer to this draft and an account.", nameof(assignments));
        }
        database.Projects.Add(new Project
        {
            Id = id,
            OrganizationId = organizationId,
            SchemaVersion = document.SchemaVersion,
            DocumentJson = serialized.Value!,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        database.ProjectAssignments.AddRange(assignments);
        return true;
    }

    private static async Task AdvanceAsync(ApplicationDbContext database, ProjectAccessSnapshot project, bool archived, CancellationToken cancellationToken)
    {
        var affected = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE projects SET archived = {archived}, revision = revision + 1, updated_at = statement_timestamp(),
                last_mutation_actor_id = NULL, last_mutation_id = NULL, last_mutation_digest = NULL
            WHERE id = {project.ProjectId} AND organization_id = {project.OrganizationId} AND revision = {project.Revision}
            """, cancellationToken);
        if (affected != 1) { throw new DbUpdateConcurrencyException("The locked project changed."); }
    }

    private static async Task<IResult> CommitAsync(HttpContext context, ApplicationDbContext database,
        IDbContextTransaction transaction, Guid id, bool created, CancellationToken cancellationToken)
    {
        var metadata = await database.Projects.AsNoTracking().Where(row => row.Id == id)
            .Select(row => new ProjectMetadata(row.Id, row.Revision, row.UpdatedAt, row.IsArchived)).SingleAsync(cancellationToken);
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        context.Response.Headers.CacheControl = "no-store";
        return Results.Json(metadata, statusCode: created ? 201 : 200);
    }

    internal static IAuthoredProject Copy(IAuthoredProject document, Guid id, string title) => document switch
    {
        LegacyProject legacy => legacy with { ProjectId = id.ToString("D"), Title = title },
        ContentProject content => content with { ProjectId = id.ToString("D"), Title = title },
        _ => throw new InvalidOperationException("Unsupported validated project format.")
    };
    private static bool ValidTitle(string? title) => !string.IsNullOrWhiteSpace(title) && title.Length <= 256 && !title.Contains('\0');
    private static bool ValidRevision(long revision) => revision is >= 0 and <= Project.MaxRevision;
    private static bool ValidIds(Guid[]? ids) => ids is { Length: <= 100 } && !ids.Contains(Guid.Empty) && ids.Distinct().Count() == ids.Length;
    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;
    private static IResult? AccountFailure(HttpContext context, CurrentAccount? account) => account is null
        ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired)
        : account.MustChangePassword ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired) : null;
    private static IResult InvalidInput(HttpContext context) => ApiProblems.Create(context, 400, "invalid_project_input", "Check the supplied project details.");
    private static IResult InvalidDocument(HttpContext context) => ProjectHttpResults.FromSave(context, ProjectSaveResult.Invalid());
    private static IResult RevisionProblem(HttpContext context, long revision, bool exhausted = false) => ProjectHttpResults.FromSave(context,
        ProjectSaveResult.Rejected(exhausted ? ProjectSaveDecision.RevisionExhausted : ProjectSaveDecision.Conflict, revision));
}
