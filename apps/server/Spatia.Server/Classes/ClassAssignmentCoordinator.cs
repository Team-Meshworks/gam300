using System.Data;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Classes;

internal static class ClassAssignmentCoordinator
{
    internal static async Task<IResult> CreateAsync(Guid id, ClassAssignmentRequest request, HttpContext context,
        ApplicationDbContext database, ProjectAccessService access, ProjectDocumentService documents, CancellationToken cancellationToken)
    {
        if (!ClassAssignmentIntent.IsValid(request))
        {
            return ApiProblems.Create(context, 400, "invalid_assignment_input", "Check the assignment details and selected students.");
        }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var (classroom, failure) = await ClassroomEndpoints.FindAsync(id, context, database, access, true, true, cancellationToken);
        if (failure is not null) { return failure; }
        var organizationId = classroom!.OrganizationId;
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        var digest = ClassAssignmentIntent.Digest(request, id, account.UserId);
        var students = request.StudentIds!.Order().ToArray();
        var existing = await database.ClassAssignments.AsNoTracking().SingleOrDefaultAsync(row => row.Id == request.RequestId, cancellationToken);
        if (existing is not null)
        {
            if (existing.ClassroomId != id || existing.CreatedByUserId != account.UserId
                || !CryptographicOperations.FixedTimeEquals(existing.RequestDigest, digest))
            {
                return Conflict(context);
            }
            var replay = await ReadProjectsAsync(database, existing.Id, cancellationToken);
            var validOrigins = await (from mapping in database.ClassAssignmentStudents
                                      join origin in database.ProjectProvenances on mapping.ProjectId equals origin.ProjectId
                                      where mapping.AssignmentId == existing.Id && mapping.OriginallyAssigned && origin.Kind == ProjectProvenance.Class
                                          && origin.ClassAssignmentId == mapping.AssignmentId && origin.StudentId == mapping.StudentId
                                      select mapping.ProjectId).CountAsync(cancellationToken);
            if (!replay.Select(row => row.StudentId).SequenceEqual(students) || validOrigins != students.Length)
            {
                return ApiProblems.Create(context, 503, "class_assignment_unavailable", "The assignment is unavailable.");
            }
            if (account.Role != ApplicationRoles.Administrator)
            {
                var projectIds = replay.Select(row => row.ProjectId).ToArray();
                var authorized = await database.ProjectAssignments.CountAsync(row => row.UserId == account.UserId
                    && row.CanManage && projectIds.Contains(row.ProjectId), cancellationToken);
                if (authorized != projectIds.Length) { return Unavailable(context); }
            }
            return await ClassroomEndpoints.CompleteAsync(context, transaction,
                Results.Ok(new { assignmentId = existing.Id, projects = replay }), cancellationToken);
        }

        if (!await database.Organizations.AnyAsync(row => row.Id == organizationId && row.IsActive, cancellationToken))
        {
            return ApiProblems.Create(context, 422, "organization_unavailable", "Choose an active organization.");
        }
        var eligible = await (from member in database.ClassroomMembers
                              join user in database.Users on member.UserId equals user.Id
                              join role in database.Roles on member.RoleId equals role.Id
                              where member.ClassroomId == id && member.IsActive && students.Contains(member.UserId)
                                  && member.RoleId == ApplicationRoles.CreatorId && role.Name == ApplicationRoles.Creator && user.IsActive
                              select member.UserId).CountAsync(cancellationToken);
        if (eligible != students.Length)
        {
            return ApiProblems.Create(context, 422, "invalid_class_members", "Choose active students enrolled in this class.");
        }
        var managers = await (from member in database.ClassroomMembers
                              join user in database.Users on member.UserId equals user.Id
                              join role in database.Roles on member.RoleId equals role.Id
                              where member.ClassroomId == id && member.IsActive && member.RoleId == ApplicationRoles.EducatorId
                                  && role.Name == ApplicationRoles.Educator && user.IsActive
                              orderby member.UserId
                              select member.UserId).ToArrayAsync(cancellationToken);
        if (managers.Length > 100)
        {
            return ApiProblems.Create(context, 422, "too_many_class_managers", "Reduce the number of class managers before creating an assignment.");
        }
        var authorization = await access.LockAsync(context, request.SourceProjectId!.Value, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (authorization.Failure is { } sourceFailure) { return ProjectHttpResults.FromAccessFailure(context, sourceFailure); }
        var source = authorization.Snapshot!;
        if (source.OrganizationId != organizationId)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound);
        }
        if (request.SourceRevision != source.Revision)
        {
            return ProjectHttpResults.FromSave(context, ProjectSaveResult.Rejected(ProjectSaveDecision.Conflict, source.Revision));
        }
        var document = documents.ReadStored(source.ProjectId, source.SchemaVersion, source.UnvalidatedDocumentJson);
        if (!document.Ok) { return ApiProblems.Create(context, 503, "project_unavailable", "The project is unavailable."); }

        var assignment = new ClassAssignment
        {
            Id = request.RequestId!.Value,
            ClassroomId = id,
            OrganizationId = organizationId,
            CreatedByUserId = account.UserId,
            SourceProjectId = source.ProjectId,
            SourceRevision = source.Revision,
            DueAtUnixSeconds = request.DueAtUnixSeconds!.Value,
            Title = request.Title!,
            Description = request.Description!,
            Instructions = request.Instructions!,
            RequestDigest = digest,
        };
        database.ClassAssignments.Add(assignment);
        try { await database.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateException error) when (error.InnerException is PostgresException
        { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "PK_class_assignments" })
        { return Conflict(context); }
        database.ChangeTracker.Clear();

        // Keep one immutable image reference across every student draft without copying the uploaded bytes
        var imageId = await database.Projects.Where(project => project.Id == source.ProjectId)
            .Select(project => project.ImageId).SingleAsync(cancellationToken);
        var projects = new List<StudentProject>(students.Length);
        foreach (var student in students)
        {
            var projectId = Guid.NewGuid();
            var grants = managers.Select(manager => new ProjectAssignment
            {
                ProjectId = projectId,
                UserId = manager,
                CanEdit = true,
                CanManage = true,
                CanPublish = true,
            }).Append(new ProjectAssignment { ProjectId = projectId, UserId = student, CanEdit = true, CanPublish = true }).ToArray();
            var copy = ProjectLifecycleEndpoints.Copy(document.Value!, projectId, request.Title!);
            if (!ProjectLifecycleEndpoints.StageDraft(database, documents, organizationId, copy, grants, imageId))
            {
                return ApiProblems.Create(context, 503, "project_unavailable", "The project is unavailable.");
            }
            database.ClassAssignmentStudents.Add(new ClassAssignmentStudent
            {
                AssignmentId = assignment.Id,
                ClassroomId = id,
                OrganizationId = organizationId,
                StudentId = student,
                ProjectId = projectId,
            });
            database.ProjectProvenances.Add(new ProjectProvenance
            {
                ProjectId = projectId,
                OrganizationId = organizationId,
                Kind = ProjectProvenance.Class,
                ClassAssignmentId = assignment.Id,
                StudentId = student,
            });
            await database.SaveChangesAsync(cancellationToken);
            database.ChangeTracker.Clear();
            projects.Add(new(student, projectId));
        }
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            Results.Json(new { assignmentId = assignment.Id, projects }, statusCode: 201), cancellationToken);
    }

    private static Task<StudentProject[]> ReadProjectsAsync(ApplicationDbContext database, Guid assignmentId,
        CancellationToken cancellationToken) => database.ClassAssignmentStudents.AsNoTracking()
        .Where(row => row.AssignmentId == assignmentId && row.OriginallyAssigned).OrderBy(row => row.StudentId)
        .Select(row => new StudentProject(row.StudentId, row.ProjectId)).ToArrayAsync(cancellationToken);

    private static IResult Conflict(HttpContext context) =>
        ApiProblems.Create(context, 409, "assignment_request_conflict", "This assignment request ID is already in use.");
    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "class_assignment_not_found", "The assignment is unavailable.");

    private sealed record StudentProject(Guid StudentId, Guid ProjectId);
}
