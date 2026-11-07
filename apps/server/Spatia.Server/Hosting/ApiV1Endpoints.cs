using Microsoft.AspNetCore.Antiforgery;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Classes;
using Spatia.Server.Projects;
using Spatia.Server.Publications;
using Spatia.Server.Reviews;

namespace Spatia.Server.Hosting;

/// <summary>Registers the v1 HTTP contract</summary>
public static class ApiV1Endpoints
{
    public const string Prefix = "/api/v1";

    public static void MapApiV1(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/auth/csrf", (HttpContext context, IAntiforgery antiforgery) =>
        {
            var tokens = antiforgery.GetAndStoreTokens(context);
            return Results.Ok(new { requestToken = tokens.RequestToken });
        }).AllowAnonymous();
        endpoints.MapAssetAdministration();
        endpoints.MapAssetDelivery();
        endpoints.MapPublicationDelivery();
        endpoints.MapPublicationWrites();
        endpoints.MapAccountAdministration();
        endpoints.MapAccountDirectory();
        endpoints.MapAccountSessions();
        endpoints.MapProjectReads();
        endpoints.MapProjectSaves();
        endpoints.MapProjectLifecycle();
        endpoints.MapClassrooms();
        endpoints.MapReviewSubmissions();
        endpoints.MapProgressReviews();
    }
}
