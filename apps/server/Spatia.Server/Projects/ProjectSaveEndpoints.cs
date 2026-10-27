using Microsoft.AspNetCore.Mvc;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>
/// Exposes bounded conditional draft saves through the registered transaction coordinator
/// </summary>
public static class ProjectSaveEndpoints
{
    /// <summary>
    /// Maps the protected save route with the shared request budget and existing antiforgery enforcement
    /// </summary>
    public static IEndpointRouteBuilder MapProjectSaves(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPut("/api/projects/{id:guid}", async (HttpContext context, Guid id, ProjectSaveService saves,
            CancellationToken cancellationToken) =>
        {
            var parsed = await SaveEnvelopeReader.ReadAsync(context.Request, id, cancellationToken);
            if (parsed.Error is { } error)
            {
                return ApiProblems.Create(context, error.StatusCode, error.Code, error.Message);
            }
            return ProjectHttpResults.FromSave(context, await saves.SaveAsync(context, id, parsed.Envelope!, cancellationToken));
        }).RequireAuthorization(SecurityPolicies.FullAccount)
            .WithMetadata(new RequestSizeLimitAttribute(SaveEnvelopeReader.MaxRequestBytes));
        return endpoints;
    }
}
