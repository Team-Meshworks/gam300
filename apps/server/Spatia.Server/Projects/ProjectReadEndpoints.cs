using System.Data;
using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Publications;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>
/// Exposes current-authorized project summaries and validated documents
/// </summary>
public static class ProjectReadEndpoints
{
    /// <summary>
    /// Maps project list, open and management grant reads under the full-account policy
    /// </summary>
    public static IEndpointRouteBuilder MapProjectReads(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/projects").RequireAuthorization(SecurityPolicies.FullAccount);
        group.MapGet("/{id:guid}/assignments", ReadAssignmentsAsync);
        group.MapGet("", async (HttpContext context, ProjectAccessService access, ProjectDocumentService documents,
            ApplicationDbContext database, CancellationToken cancellationToken) =>
        {
            var query = context.Request.Query;
            var limit = 10;
            Guid? cursor = null;
            if (query.Any(pair => pair.Value.Count != 1 || pair.Key is not ("limit" or "cursor" or "archived" or "published"))
                || (query.TryGetValue("limit", out var rawLimit)
                    && (!int.TryParse(rawLimit, NumberStyles.None, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 20))
                || (query.TryGetValue("archived", out var rawArchived) && rawArchived[0] is not ("true" or "false"))
                || (query.TryGetValue("published", out var rawPublished) && rawPublished[0] is not ("true" or "false")))
            {
                return InvalidQuery(context);
            }
            if (query.TryGetValue("cursor", out var rawCursor))
            {
                if (rawCursor[0]?.Length != 36 || !Guid.TryParseExact(rawCursor[0], "D", out var id))
                {
                    return InvalidQuery(context);
                }
                cursor = id;
            }
            var result = await access.ListAsync(context, cursor, limit, query["archived"] == "true", cancellationToken, published: query["published"] == "true");
            if (result.Failure is { } failure)
            {
                return ProjectHttpResults.FromAccessFailure(context, failure);
            }

            // Resolve visibility for this bounded page in one query using the visitor access restrictions
            var pageIds = result.Projects.Select(project => project.ProjectId).ToArray();
            var retired = database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids");
            var metadata = await (from project in database.Projects.AsNoTracking()
                                  join organization in database.Organizations.AsNoTracking() on project.OrganizationId equals organization.Id
                                  where pageIds.Contains(project.Id)
                                  select new
                                  {
                                      project.Id,
                                      ImageType = database.ProjectImages.Where(image => image.Id == project.ImageId).Select(image => image.Type).FirstOrDefault(),
                                      OrganizationName = organization.Name,
                                      IsClassProject = database.ClassAssignments.Any(assignment => assignment.SourceProjectId == project.Id)
                                          || database.ClassAssignmentStudents.Any(student => student.ProjectId == project.Id),
                                      IsPublic = !project.IsArchived && (from edition in database.Publications
                                                                         join state in database.PublicationAccess on edition.Id equals state.PublicationId
                                                                         where edition.ProjectId == project.Id
                                                                             && (state.Audience == (int)PublicationAudience.Public || state.Audience == (int)PublicationAudience.Unlisted)
                                                                             && !state.Hidden && !state.Revoked && !state.Deleted
                                                                             && !retired.Contains(edition.Id)
                                                                         select edition.Id).Any(),
                                  }).ToDictionaryAsync(row => row.Id, cancellationToken);
            var published = query["published"] == "true"
                ? await database.Projects.AsNoTracking().Where(project => pageIds.Contains(project.Id))
                    .Select(project => new { project.Id, Edition = database.Publications
                        .Where(edition => edition.ProjectId == project.Id && !retired.Contains(edition.Id)
                            && !database.PublicationAccess.Any(state => state.PublicationId == edition.Id && state.Deleted))
                        .OrderByDescending(edition => edition.CreatedAt).ThenByDescending(edition => edition.Id).FirstOrDefault() })
                    .ToDictionaryAsync(row => row.Id, row => row.Edition, cancellationToken)
                : null;
            var items = new List<ProjectSummary>();
            foreach (var project in result.Projects)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var edition = published?.GetValueOrDefault(project.ProjectId);
                if (published is not null && edition is null) { return Unavailable(context); }
                var document = documents.ReadStored(project.ProjectId, edition?.SchemaVersion ?? project.SchemaVersion,
                    edition?.DocumentJson ?? project.UnvalidatedDocumentJson);
                if (!document.Ok)
                {
                    return Unavailable(context);
                }
                var title = document.Value!.Title;
                // Legacy titles can fill a document; summaries remain bounded without splitting a surrogate pair
                if (title.Length > 256)
                {
                    title = title[..(char.IsHighSurrogate(title[254]) ? 254 : 255)] + "…";
                }
                if (!metadata.TryGetValue(project.ProjectId, out var details)) { return Unavailable(context); }
                items.Add(new(project.ProjectId, title, edition?.SourceRevision ?? project.Revision, edition?.CreatedAt ?? project.UpdatedAt, project.IsArchived, Permissions(project),
                    details.OrganizationName, details.IsPublic, details.ImageType is null ? null : new ProjectImageMetadata(details.ImageType, $"/api/v1/projects/{project.ProjectId:D}/image"), details.IsClassProject));
            }
            return HasExpired(context)
                ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired)
                : Results.Ok(new { items, result.NextCursor });
        });
        group.MapGet("/{id:guid}", async (HttpContext context, Guid id, ProjectAccessService access,
            ProjectDocumentService documents, CancellationToken cancellationToken) =>
        {
            var result = await access.ReadAsync(context, id, cancellationToken);
            if (result.Failure is { } failure)
            {
                return ProjectHttpResults.FromAccessFailure(context, failure);
            }
            var project = result.Snapshot!;
            var document = documents.ReadStored(id, project.SchemaVersion, project.UnvalidatedDocumentJson);
            if (!document.Ok)
            {
                return Unavailable(context);
            }
            var serialized = documents.Serialize(document.Value!);
            if (!serialized.Ok)
            {
                return Unavailable(context);
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (HasExpired(context))
            {
                return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);
            }
            // An interface-typed model would omit its scene fields; return the complete checked serializer output
            using var json = JsonDocument.Parse(serialized.Value!);
            return Results.Ok(new
            {
                projectId = project.ProjectId,
                project.Revision,
                project.UpdatedAt,
                document = json.RootElement.Clone(),
                permissions = Permissions(project),
            });
        });
        return endpoints;
    }

    private static async Task<IResult> ReadAssignmentsAsync(Guid id, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (context.Request.Query.Count != 0) { return InvalidQuery(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        var project = await access.VisibleProjects(account).Where(row => row.Id == id)
            .Select(row => new { row.Id, row.OrganizationId, row.Revision, row.IsArchived }).SingleOrDefaultAsync(cancellationToken);
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (project is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }
        if (account.Role == ApplicationRoles.Creator)
        {
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
        }
        // Keep stored grants intact, including inactive accounts and flags the replacement API cannot represent
        var assignments = await database.ProjectAssignments.AsNoTracking().Where(row => row.ProjectId == id).OrderBy(row => row.UserId)
            .Select(row => new { row.UserId, row.CanEdit, row.CanManage, row.CanPublish }).ToArrayAsync(cancellationToken);

        // Resolve only this project's class contexts rather than loading every class and assignment
        var visibleProjects = access.VisibleProjects(account);
        var classAssignments = await (from assignment in database.ClassAssignments.AsNoTracking()
                                      join classroom in database.Classrooms.AsNoTracking() on assignment.ClassroomId equals classroom.Id
                                      where account.Role == ApplicationRoles.Administrator && classroom.OrganizationId == project.OrganizationId
                                          && database.ClassAssignmentStudents.Any(mapping => mapping.AssignmentId == assignment.Id && mapping.IsActive
                                              && (assignment.SourceProjectId == id || mapping.ProjectId == id)
                                              && visibleProjects.Any(draft => draft.Id == mapping.ProjectId))
                                      orderby classroom.Name, assignment.Id
                                      select new { classId = classroom.Id, className = classroom.Name, assignmentId = assignment.Id })
            .ToArrayAsync(cancellationToken);
        if (HasExpired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        await transaction.CommitAsync(cancellationToken);
        return HasExpired(context)
            ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired)
            : Results.Ok(new { projectId = project.Id, project.OrganizationId, project.Revision, archived = project.IsArchived, assignments, classAssignments });
    }

    private static ProjectPermissions Permissions(ProjectAccessSnapshot project) =>
        new(project.CanEdit, project.CanManage, project.CanPublish);

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    private static IResult InvalidQuery(HttpContext context) =>
        ApiProblems.Create(context, 400, "invalid_project_query", "Check the project list filters and cursor.");

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 503, "project_unavailable", "Project content is unavailable.");
}
