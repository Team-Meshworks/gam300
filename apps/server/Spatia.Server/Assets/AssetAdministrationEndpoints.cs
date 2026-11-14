using System.Data;
using Microsoft.AspNetCore.Mvc;
using Spatia.Server.Accounts;
using Spatia.Server.Projects;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using Spatia.Server.Persistence;
using Spatia.Server.Hosting;
using Spatia.Server.Security;

namespace Spatia.Server.Assets;

/// <summary>Maps administrator-only intake and retirement through the existing cookie and CSRF boundaries</summary>
public static class AssetAdministrationEndpoints
{
    public static IEndpointRouteBuilder MapAssetAdministration(this IEndpointRouteBuilder endpoints)
    {

        // Use the current administrator session for every route and reuse the application's write protections
        var group = endpoints.MapGroup("/admin/assets").RequireAuthorization(SecurityPolicies.Administrator)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);

        // Return current server capabilities with the list so the screen never guesses which writes are available
        group.MapGet("", async (AssetAdministrationService service, AssetUploadValidator validator, CancellationToken token) => Results.Ok(new
        {
            assets = await service.ListAsync(token),
            policy = new
            {
                extensions = new[] { ".glb", ".m4a" },
                maxBytes = AssetIntakePolicy.MaxBytes,
                categories = new { environment = (string[]?)null, model = AssetIntakePolicy.ModelCategories, audio = AssetIntakePolicy.AudioCategories },
                canSubmit = validator.IsAvailable,
                canSubmitByKind = new { environment = validator.IsAvailable, model = validator.IsAvailable, audio = true },
                canForceRemove = true
            },
        }));

        // Allow review of quarantined bytes without exposing them through the student catalogue
        group.MapGet("/{id:guid}/bytes", async (Guid id, HttpContext context, ApplicationDbContext database, CancellationToken token) =>
        {
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(asset => asset.Id == id, token);
            if (asset is null) { return ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable"); }

            // Keep quarantined bytes an explicit download so inspection never becomes public library delivery
            context.Response.Headers.XContentTypeOptions = "nosniff";
            return Results.File(asset.Bytes, AssetIntakePolicy.MediaType(asset.Kind), $"asset-{asset.Id}{AssetIntakePolicy.Extension(asset.Kind)}");
        }).RequireRateLimiting("AssetBytes");
        group.MapPost("", UploadAsync).WithMetadata(new RequestSizeLimitAttribute(AssetIntakePolicy.MaxBytes))
            .RequireRateLimiting("AssetIntake");

        // Allow the bounded review fields even when JSON escapes non-ASCII text
        group.MapPost("/{id:guid}/approve", async (Guid id, AssetReviewRequest request, HttpContext context,
            AssetAdministrationService service, CancellationToken token) =>
        {
            if (!ValidReview(request))
            {
                return Invalid(context);
            }

            // Bind approval to the authenticated reviewer rather than accepting an actor from request JSON
            var actor = context.Features.Get<CurrentAccount>()!.UserId;
            var record = await service.ReviewAsync(id, request, actor, token);
            return record is null ? ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before reviewing it") : Results.Ok(record);
        }).WithMetadata(new RequestSizeLimitAttribute(40 * 1024));
        group.MapPost("/{id:guid}/availability", async (Guid id, AssetAvailabilityRequest request, HttpContext context,
            AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access,
            ProjectDocumentService documents, CancellationToken token) =>
        {

            // Final removal follows ordinary deletion and cannot be combined with hiding or showing
            if (request.Action is not ("hide" or "show" or "delete" or "remove")
                || (request.RemoveFromProjects && request.Action != "remove"))
            {
                return Invalid(context);
            }

            if (request.RemoveFromProjects || request.Action == "remove")
            {
                await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, token);
                if (await RecheckAdministratorAsync(context, access, token) is { } denied) { return denied; }
                var removed = await service.RemoveAsync(id, documents, token);
                if (removed is null) { return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing it"); }
                if (await RecheckAdministratorAsync(context, access, token) is { } changed) { return changed; }
                await transaction.CommitAsync(token);
                token.ThrowIfCancellationRequested();
                return context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc
                    ? ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired) : Results.Ok(removed);
            }
            var record = await service.ChangeAsync(id, request.Action, token);
            return record is null ? ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing it") : Results.Ok(record);
        });
        return endpoints;
    }

    private static async Task<IResult> UploadAsync(HttpContext context, AssetAdministrationService service, CancellationToken token)
    {
        AssetReviewRequest? metadata = null;
        if (context.Request.Headers.TryGetValue("X-Spatia-Asset-Metadata", out var encoded))
        {
            if (encoded.Count != 1 || encoded[0] is not { Length: <= 32768 } value) { return Invalid(context); }
            try
            {
                metadata = JsonSerializer.Deserialize<AssetReviewRequest>(Convert.FromBase64String(value), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            }
            catch (Exception exception) when (exception is FormatException or JsonException)
            {
                return Invalid(context);
            }
            if (metadata is null || !ValidReview(metadata)) { return Invalid(context); }
        }
        var query = context.Request.Query;
        if (query.Any(pair => pair.Value.Count != 1 || pair.Key is not ("name" or "kind" or "category")))
        {
            return Invalid(context);
        }

        // Check metadata before reading the body; uploaded names remain labels rather than filesystem paths
        var name = query["name"].ToString();
        var kind = query["kind"].ToString();
        var category = query.TryGetValue("category", out var raw) ? raw.ToString() : null;
        if (!AssetIntakePolicy.Accepts(name, kind, category) || context.Request.ContentType != AssetIntakePolicy.MediaType(kind))
        {
            return Invalid(context);
        }

        // Read only after authorization and stop at the same cap even for chunked requests
        using var buffer = new MemoryStream();
        var chunk = new byte[64 * 1024];
        int count;
        while ((count = await context.Request.Body.ReadAsync(chunk, token)) != 0)
        {
            if (buffer.Length + count > AssetIntakePolicy.MaxBytes)
            {
                return ApiProblems.Create(context, 413, "asset_too_large", "Asset exceeds the 20 MB limit");
            }
            await buffer.WriteAsync(chunk.AsMemory(0, count), token);
        }
        if (buffer.Length == 0)
        {
            return Invalid(context);
        }
        var actor = context.Features.Get<CurrentAccount>()!.UserId;

        // Validation or storage unavailability leaves no approved entry and must remain retryable to the client
        var result = await service.SubmitAsync(name, kind, category, buffer.ToArray(), actor, metadata, token);
        return result is { } upload
            ? Results.Json(upload.Record, statusCode: upload.Created ? StatusCodes.Status201Created : StatusCodes.Status200OK)
            : ApiProblems.Create(context, 503, "asset_intake_unavailable", "Asset validation or storage is unavailable");
    }

    private static async Task<IResult?> RecheckAdministratorAsync(HttpContext context, ProjectAccessService access, CancellationToken token)
    {
        var account = await access.ResolveCurrentAccountAsync(context, token);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        return account.Role == ApplicationRoles.Administrator ? null
            : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
    }

    private static bool ValidReview(AssetReviewRequest request) =>
        new[] { request.Source, request.License, request.ReviewNotes }
            .All(value => value is null || (value.Length <= 2000 && !value.Any(char.IsControl)));

    private static IResult Invalid(HttpContext context) => ApiProblems.Create(context, 400, "invalid_asset_input", "Check the asset file and metadata");
}
