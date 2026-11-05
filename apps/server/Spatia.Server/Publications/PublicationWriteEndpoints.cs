using System.Text.Json;
using Spatia.Server.Hosting;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

internal static class PublicationWriteEndpoints
{
    internal static void MapPublicationWrites(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/projects/{id:guid}/publications", async (Guid id, PublishSnapshotRequest input,
            PublicationCoordinator coordinator, HttpContext context, IConfiguration configuration, CancellationToken token) =>
        {
            if (id == Guid.Empty || input.PublicationId is not { } publicationId || publicationId == Guid.Empty
                || input.ConfirmedRevision is not { } revision || revision < 0 || revision > Project.MaxRevision
                || input.Intent.ValueKind != JsonValueKind.Object)
            { return ApiProblems.Create(context, 400, "invalid_publication", "Check the publication request."); }
            // Only trusted configuration defines links; neither Host nor forwarded headers select a public origin
            if (!Uri.TryCreate(configuration["Publication:Origin"], UriKind.Absolute, out var origin)
                || origin.Scheme != Uri.UriSchemeHttps || origin.UserInfo.Length != 0 || origin.AbsolutePath != "/"
                || origin.Query.Length != 0 || origin.Fragment.Length != 0)
            { return ApiProblems.Create(context, 503, "publication_unavailable", "Publication is not configured."); }
            PublicationRequest request;
            try { request = new(publicationId, revision, input.Intent.GetRawText()); }
            catch (Exception error) when (error is ArgumentException or JsonException)
            { return ApiProblems.Create(context, 400, "invalid_publication", "Check the publication request."); }
            var result = await coordinator.PublishAsync(context, id, request, token);
            if (result.AccessFailure is { } accessFailure) { return ProjectHttpResults.FromAccessFailure(context, accessFailure); }
            if (result.Acknowledgement is { } ack)
            {
                var snapshotUrl = new Uri(origin, $"api/publications/{ack.PublicationId:D}").AbsoluteUri;
                var visitorUrl = new Uri(origin, $"p/{ack.PublicationId:D}").AbsoluteUri;
                var body = new { ack.PublicationId, ack.ProjectId, ack.SourceRevision, ack.CreatedAt, snapshotUrl, visitorUrl };
                context.Response.Headers.CacheControl = "private, no-store";
                return result.IsReplay ? Results.Ok(body) : Results.Created(snapshotUrl, body);
            }
            var status = result.Rejection switch
            {
                PublicationRejection.RevisionConflict or PublicationRejection.IdConflict or PublicationRejection.ApprovalRequired => 409,
                PublicationRejection.PolicyDenied => 403,
                PublicationRejection.InvalidAssets or PublicationRejection.InvalidDocument or PublicationRejection.UnsupportedRuntime => 422,
                _ => 503,
            };
            var code = result.Rejection switch
            {
                PublicationRejection.RevisionConflict => "revision_conflict",
                PublicationRejection.IdConflict => "publication_id_conflict",
                PublicationRejection.ApprovalRequired => "approval_required",
                PublicationRejection.PolicyDenied => "publication_access_denied",
                PublicationRejection.InvalidAssets => "publication_assets_unavailable",
                PublicationRejection.InvalidDocument => "invalid_document",
                PublicationRejection.UnsupportedRuntime => "unsupported_publication_runtime",
                _ => "publication_unavailable",
            };
            var problem = ApiProblems.Create(context, status, code, "The publication could not be created.");
            if (result.CurrentRevision is { } current) { problem.ProblemDetails.Extensions["currentRevision"] = current; }
            return problem;
        }).RequireAuthorization(SecurityPolicies.FullAccount).RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024));
    }
}
