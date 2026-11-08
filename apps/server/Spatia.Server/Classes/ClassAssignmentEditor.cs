using System.Data;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Classes;

internal sealed record EditClassAssignmentRequest(Guid? MutationId, long? ExpectedRevision, long? DueAtUnixSeconds,
    string? Title, string? Description, string? Instructions, Guid[]? StudentIds);

internal static class ClassAssignmentEditor
{
    internal static async Task<IResult> UpdateAsync(Guid id, Guid assignmentId, EditClassAssignmentRequest request,
        HttpContext context, ApplicationDbContext database, ProjectAccessService access,
        ProjectDocumentService documents, CancellationToken cancellationToken)
    {
        var validation = new ClassAssignmentRequest(request.MutationId, Guid.NewGuid(), 0, request.DueAtUnixSeconds,
            request.Title, request.Description, request.Instructions, request.StudentIds);
        if (assignmentId == Guid.Empty || request.ExpectedRevision is not (>= 0 and < Project.MaxRevision)
            || !ClassAssignmentIntent.IsValid(validation))
        { return ApiProblems.Create(context, 400, "invalid_assignment_input", "Check the project details and selected students."); }

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var (classroom, failure) = await ClassroomEndpoints.FindAsync(id, context, database, access, true, true, cancellationToken);
        if (failure is not null) { return failure; }
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null || account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        var assignment = await database.ClassAssignments.SingleOrDefaultAsync(row => row.Id == assignmentId && row.ClassroomId == id, cancellationToken);
        if (assignment is null) { return Unavailable(context); }
        var requestedStudents = request.StudentIds!.Order().ToArray();
        var digest = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { version = 1, classroomId = id,
            assignmentId, actorId = account.UserId, request.MutationId, request.ExpectedRevision,
            request.DueAtUnixSeconds, request.Title, request.Description, request.Instructions, studentIds = requestedStudents }));
        var mappings = await database.ClassAssignmentStudents.Where(row => row.AssignmentId == assignmentId).ToArrayAsync(cancellationToken);
        var mappedProjectIds = mappings.Select(row => row.ProjectId).ToArray();
        var visible = await access.VisibleProjects(account).Where(project => mappedProjectIds.Contains(project.Id))
            .Select(project => project.Id).ToArrayAsync(cancellationToken);
        if (mappings.Any(row => row.IsActive && !visible.Contains(row.ProjectId))) { return Unavailable(context); }
        if (assignment.LastEditId == request.MutationId)
        {
            if (assignment.LastEditActorId != account.UserId || assignment.LastEditDigest is null
                || !CryptographicOperations.FixedTimeEquals(assignment.LastEditDigest, digest)) { return Conflict(context); }
            return await ClassroomEndpoints.CompleteAsync(context, transaction,
                Results.Ok(new { assignmentId, revision = assignment.Revision }), cancellationToken);
        }
        if (assignment.Revision != request.ExpectedRevision) { return Conflict(context); }
        var eligible = await (from member in database.ClassroomMembers
                              join user in database.Users on member.UserId equals user.Id
                              join role in database.Roles on member.RoleId equals role.Id
                              where member.ClassroomId == id && member.IsActive && requestedStudents.Contains(member.UserId)
                                  && member.RoleId == ApplicationRoles.CreatorId && role.Name == ApplicationRoles.Creator && user.IsActive
                              select member.UserId).CountAsync(cancellationToken);
        if (eligible != requestedStudents.Length)
        { return ApiProblems.Create(context, 422, "invalid_class_members", "Choose active students enrolled in this class."); }
        var newStudents = requestedStudents.Except(mappings.Select(row => row.StudentId)).ToArray();
        var projectIds = mappings.Select(row => row.ProjectId).Concat(newStudents.Length > 0 ? [assignment.SourceProjectId] : Array.Empty<Guid>())
            .Distinct().Order().ToArray();
        var snapshots = new Dictionary<Guid, ProjectAccessSnapshot>();
        foreach (var projectId in projectIds)
        {
            var locked = await access.LockAsync(context, projectId, ProjectLockPurpose.ManageAssignments, cancellationToken);
            if (locked.Failure is { } denied) { return ProjectHttpResults.FromAccessFailure(context, denied); }
            snapshots.Add(projectId, locked.Snapshot!);
        }
        if (newStudents.Length > 0 && snapshots[assignment.SourceProjectId].Revision != assignment.SourceRevision)
        { return ApiProblems.Create(context, 409, "assignment_source_changed", "The original project changed. New student drafts cannot be created from it."); }
        var metadataChanged = assignment.Title != request.Title || assignment.Description != request.Description
            || assignment.Instructions != request.Instructions || assignment.DueAtUnixSeconds != request.DueAtUnixSeconds;
        foreach (var mapping in mappings)
        {
            var active = requestedStudents.Contains(mapping.StudentId);
            if (!mapping.IsActive && !active) { continue; }
            if (!metadataChanged && active == mapping.IsActive) { continue; }
            var project = await database.Projects.SingleAsync(row => row.Id == mapping.ProjectId, cancellationToken);
            if (project.Revision >= Project.MaxRevision) { return Conflict(context); }
            if (assignment.Title != request.Title)
            {
                var original = documents.ReadStored(project.Id, project.SchemaVersion, project.DocumentJson);
                if (!original.Ok) { return Unavailable(context); }
                var renamed = documents.Serialize(ProjectLifecycleEndpoints.Copy(original.Value!, project.Id, request.Title!));
                if (!renamed.Ok) { return Unavailable(context); }
                project.DocumentJson = renamed.Value!;
            }
            project.Revision++;
            project.UpdatedAt = DateTimeOffset.UtcNow;
            project.LastMutationActorId = null;
            project.LastMutationId = null;
            project.LastMutationDigest = null;
            mapping.IsActive = active;
        }
        if (newStudents.Length > 0)
        {
            var source = snapshots[assignment.SourceProjectId];
            var sourceDocument = documents.ReadStored(source.ProjectId, source.SchemaVersion, source.UnvalidatedDocumentJson);
            if (!sourceDocument.Ok) { return Unavailable(context); }
            var managers = await (from member in database.ClassroomMembers
                                  join user in database.Users on member.UserId equals user.Id
                                  join role in database.Roles on member.RoleId equals role.Id
                                  where member.ClassroomId == id && member.IsActive && member.RoleId == ApplicationRoles.EducatorId
                                      && role.Name == ApplicationRoles.Educator && user.IsActive
                                  select member.UserId).ToArrayAsync(cancellationToken);
            if (managers.Length > 100) { return Conflict(context); }
            foreach (var student in newStudents)
            {
                var projectId = Guid.NewGuid();
                var grants = managers.Select(manager => new ProjectAssignment { ProjectId = projectId, UserId = manager,
                    CanEdit = true, CanManage = true, CanPublish = true })
                    .Append(new ProjectAssignment { ProjectId = projectId, UserId = student, CanEdit = true }).ToArray();
                if (!ProjectLifecycleEndpoints.StageDraft(database, documents, classroom!.OrganizationId,
                    ProjectLifecycleEndpoints.Copy(sourceDocument.Value!, projectId, request.Title!), grants)) { return Unavailable(context); }
                database.ClassAssignmentStudents.Add(new ClassAssignmentStudent { AssignmentId = assignmentId, ClassroomId = id,
                    OrganizationId = classroom.OrganizationId, StudentId = student, ProjectId = projectId, OriginallyAssigned = false });
                database.ProjectProvenances.Add(new ProjectProvenance { ProjectId = projectId, OrganizationId = classroom.OrganizationId,
                    Kind = ProjectProvenance.Class, ClassAssignmentId = assignmentId, StudentId = student });
            }
        }
        assignment.Title = request.Title!;
        assignment.Description = request.Description!;
        assignment.Instructions = request.Instructions!;
        assignment.DueAtUnixSeconds = request.DueAtUnixSeconds!.Value;
        assignment.Revision++;
        assignment.LastEditId = request.MutationId;
        assignment.LastEditActorId = account.UserId;
        assignment.LastEditDigest = digest;
        await database.SaveChangesAsync(cancellationToken);
        var (_, recheck) = await ClassroomEndpoints.FindAsync(id, context, database, access, true, false, cancellationToken);
        if (recheck is not null) { return recheck; }
        var current = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (current is null || current.UserId != account.UserId || current.MustChangePassword) { return Unavailable(context); }
        return await ClassroomEndpoints.CompleteAsync(context, transaction,
            Results.Ok(new { assignmentId, revision = assignment.Revision }), cancellationToken);
    }

    private static IResult Conflict(HttpContext context) =>
        ApiProblems.Create(context, 409, "assignment_conflict", "The assignment changed. Reload before editing.");
    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 404, "class_assignment_not_found", "The assignment is unavailable.");
}
