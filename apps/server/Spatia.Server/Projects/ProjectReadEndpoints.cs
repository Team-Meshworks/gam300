using System.Globalization;
using System.Text.Json;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>
/// Exposes current-authorized project summaries and validated documents
/// </summary>
public static class ProjectReadEndpoints
{
    /// <summary>
    /// Maps bounded list and open routes under the full-account policy
    /// </summary>
    public static IEndpointRouteBuilder MapProjectReads(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/projects").RequireAuthorization(SecurityPolicies.FullAccount);
        group.MapGet("", async (HttpContext context, ProjectAccessService access, ProjectDocumentService documents,
            CancellationToken cancellationToken) =>
        {
            var query = context.Request.Query;
            var limit = 10;
            Guid? cursor = null;
            if (query.Any(pair => pair.Value.Count != 1 || pair.Key is not ("limit" or "cursor" or "archived"))
                || (query.TryGetValue("limit", out var rawLimit)
                    && (!int.TryParse(rawLimit, NumberStyles.None, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 20))
                || (query.TryGetValue("archived", out var rawArchived) && rawArchived[0] is not ("true" or "false")))
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
            var result = await access.ListAsync(context, cursor, limit, query["archived"] == "true", cancellationToken);
            if (result.Failure is { } failure)
            {
                return ProjectHttpResults.FromAccessFailure(context, failure);
            }
            var items = new List<ProjectSummary>();
            foreach (var project in result.Projects)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var document = documents.ReadStored(project.ProjectId, project.SchemaVersion, project.UnvalidatedDocumentJson);
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
                items.Add(new(project.ProjectId, title, project.Revision, project.UpdatedAt, project.IsArchived, Permissions(project)));
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

    private static ProjectPermissions Permissions(ProjectAccessSnapshot project) =>
        new(project.CanEdit, project.CanManage, project.CanPublish);

    private static bool HasExpired(HttpContext context) =>
        context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    private static IResult InvalidQuery(HttpContext context) =>
        ApiProblems.Create(context, 400, "invalid_project_query", "Check the project list filters and cursor.");

    private static IResult Unavailable(HttpContext context) =>
        ApiProblems.Create(context, 503, "project_unavailable", "Project content is unavailable.");
}
