using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Assets;

/// <summary>Maps administrator-only intake and retirement through the existing cookie and CSRF boundaries</summary>
public static partial class AssetAdministrationEndpoints
{
    public static IEndpointRouteBuilder MapAssetAdministration(this IEndpointRouteBuilder endpoints)
    {
        // Use the current administrator session for every route and reuse the application's write protections
        var group = endpoints.MapGroup("/admin/assets").RequireAuthorization(SecurityPolicies.Administrator)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);

        // Return current server capabilities with the list so the screen never guesses which writes are available
        group.MapGet("", async (HttpContext context, ProjectAccessService access, AssetAdministrationService service, AssetUploadValidator validator, CancellationToken token) =>
        {
            var assets = await service.ListAsync(token);
            var tags = await service.ListTagsAsync(token);

            if (await RecheckAdministratorAsync(context, access, token) is { } denied)
                return denied;

            return Results.Ok(new
            {
                assets,
                policy = new
                {
                    extensions = new[] { ".glb", ".m4a" },
                    maxBytes = AssetIntakePolicy.MaxBytes,
                    categories = new
                    {
                        environment = (string[]?)null,
                        model = AssetIntakePolicy.ModelCategories,
                        audio = AssetIntakePolicy.AudioCategories
                    },
                    canSubmit = validator.IsAvailable,
                    canSubmitByKind = new
                    {
                        environment = validator.IsAvailable,
                        model = validator.IsAvailable,
                        audio = true
                    },
                    canForceRemove = true,
                    // The shared tag list; admins add to it by saving a new tag on an asset
                    tags,
                    maxTags = AssetTags.MaxPerAsset,
                    maxTagLength = AssetTags.MaxLength
                },
            });
        }).RequireRateLimiting(SecurityPolicies.AssetCatalogueReadRateLimit);

        // Allow review of quarantined bytes without exposing them through the student catalogue
        group.MapGet("/{id:guid}/bytes", async (Guid id, HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) =>
        {
            var asset = await database.AssetCandidates.AsNoTracking().SingleOrDefaultAsync(asset => asset.Id == id, token);

            if (await RecheckAdministratorAsync(context, access, token) is { } denied)
                return denied;

            if (asset is null)
                return ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable");

            // Keep quarantined bytes an explicit download so inspection never becomes public library delivery
            context.Response.Headers.XContentTypeOptions = "nosniff";
            return Results.File(asset.Bytes, AssetIntakePolicy.MediaType(asset.Kind), $"asset-{asset.Id}{AssetIntakePolicy.Extension(asset.Kind)}");
        }).RequireRateLimiting("AssetBytes");
        group.MapPost("", UploadAsync).WithMetadata(new RequestSizeLimitAttribute(AssetIntakePolicy.MaxBytes))
            .RequireRateLimiting("AssetIntake");

        group.MapPut("/{id:guid}/details", async (Guid id, AssetDetailsRequest request, HttpContext context,
            AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) =>
        {
            if (!AssetIntakePolicy.ValidDisplayName(request.Name) || !AssetIntakePolicy.AcceptsCategory(request.Kind, request.Category)
                || request.Review is null || !ValidReview(request.Review) || (request.Tags is not null && AssetTags.Read(request.Tags) is null))
            {
                return Invalid(context);
            }

            await using var transaction = await database.Database.BeginTransactionAsync(token);
            if (await RecheckAdministratorAsync(context, access, token) is { } denied)
                return denied;

            var (record, stale) = await service.UpdateDetailsAsync(id, request, context.Features.Get<CurrentAccount>()!.UserId, token);
            if (await RecheckAdministratorAsync(context, access, token) is { } changed)
                return changed;
            if (stale)
                return ApiProblems.Create(context, 409, "asset_stale", "Another administrator changed this asset. Reload it before saving.");
            if (record is null)
                return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before editing it");

            await transaction.CommitAsync(token);
            if (await RecheckAdministratorAsync(context, access, token) is not null)
                return CommittedWrite.WithoutRepresentation(context);
            return Results.Ok(record);
        }).WithMetadata(new RequestSizeLimitAttribute(40 * 1024));

        // One-click removal names only the tag, leaving every newer field and tag on the asset as it is
        group.MapPost("/{id:guid}/tags/remove", async (Guid id, AssetTagRemovalRequest request, HttpContext context,
            AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) =>
        {
            if (AssetTags.Normalize(request.Tag) is not { } tag)
                return Invalid(context);

            await using var transaction = await database.Database.BeginTransactionAsync(token);
            if (await RecheckAdministratorAsync(context, access, token) is { } denied)
                return denied;

            var record = await service.RemoveTagAsync(id, tag, token);
            if (await RecheckAdministratorAsync(context, access, token) is { } changed)
                return changed;
            if (record is null)
                return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before editing it");

            await transaction.CommitAsync(token);
            if (await RecheckAdministratorAsync(context, access, token) is not null)
                return CommittedWrite.WithoutRepresentation(context);
            return Results.Ok(record);
        }).WithMetadata(new RequestSizeLimitAttribute(4 * 1024));

        // Allow the bounded review fields even when JSON escapes non-ASCII text
        group.MapPost("/{id:guid}/approve", async (Guid id, AssetReviewRequest request, HttpContext context,
            AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access, CancellationToken token) =>
        {
            if (!ValidReview(request))
                return Invalid(context);

            // Bind approval to the authenticated reviewer rather than accepting an actor from request JSON
            var actor = context.Features.Get<CurrentAccount>()!.UserId;
            await using var transaction = await database.Database.BeginTransactionAsync(token);

            if (await RecheckAdministratorAsync(context, access, token) is { } denied)
                return denied;

            var record = await service.ReviewAsync(id, request, actor, token);

            if (await RecheckAdministratorAsync(context, access, token) is { } changed)
                return changed;

            if (record is null)
                return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before reviewing it");

            await transaction.CommitAsync(token);

            if (await RecheckAdministratorAsync(context, access, token) is not null)
                return CommittedWrite.WithoutRepresentation(context);

            return Results.Ok(record);
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
                return await RemoveAsync(id, null, false, context, service, database, access, documents, token);

            await using var transaction = await database.Database.BeginTransactionAsync(token);

            if (await RecheckAdministratorAsync(context, access, token) is { } denied)
                return denied;

            var record = await service.ChangeAsync(id, request.Action, token);

            if (await RecheckAdministratorAsync(context, access, token) is { } changed)
                return changed;

            if (record is null)
                return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing it");

            await transaction.CommitAsync(token);

            if (await RecheckAdministratorAsync(context, access, token) is not null)
                return CommittedWrite.WithoutRepresentation(context);

            return Results.Ok(record);
        });
        MapRemovalReceipts(group);
        return endpoints;
    }

    private static async Task<IResult> UploadAsync(HttpContext context, AssetAdministrationService service,
        ApplicationDbContext database, ProjectAccessService access, CancellationToken token)
    {
        AssetReviewRequest? metadata = null;

        if (context.Request.Headers.TryGetValue("X-Spatia-Asset-Metadata", out var encoded))
        {
            if (encoded.Count != 1 || encoded[0] is not { Length: <= 32768 } value)
                return Invalid(context);

            try
            {
                metadata = JsonSerializer.Deserialize<AssetReviewRequest>(Convert.FromBase64String(value), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            }
            catch (Exception exception) when (exception is FormatException or JsonException)
            {
                return Invalid(context);
            }

            if (metadata is null || !ValidReview(metadata))
                return Invalid(context);
        }

        var query = context.Request.Query;

        // Tags repeat as one value each, so names may contain any character a tag allows
        if (query.Any(pair => pair.Key == "tags"
                ? pair.Value.Count is < 1 or > AssetTags.MaxPerAsset
                : pair.Value.Count != 1 || pair.Key is not ("name" or "kind" or "category" or "displayName" or "replaces")))
        {
            return Invalid(context);
        }
        var tags = AssetTags.Read(query.TryGetValue("tags", out var tagValues) ? tagValues.ToArray() : null);
        if (tags is null)
            return Invalid(context);

        // Check metadata before reading the body; uploaded names remain labels rather than filesystem paths
        var name = query["name"].ToString();
        var kind = query["kind"].ToString();
        var category = query.TryGetValue("category", out var raw) ? raw.ToString() : null;
        var displayName = query.TryGetValue("displayName", out var label) ? label.ToString() : null;
        Guid? replaces = null;
        if (query.TryGetValue("replaces", out var previous))
        {
            if (!Guid.TryParseExact(previous.ToString(), "D", out var id) || kind is not ("audio" or "model"))
                return Invalid(context);
            replaces = id;
        }

        if (!AssetIntakePolicy.Accepts(name, kind, category) || (displayName is not null && !AssetIntakePolicy.ValidDisplayName(displayName)))
            return Invalid(context);

        if (!MediaTypeHeaderValue.TryParse(context.Request.ContentType, out var contentType)
            || !contentType.MediaType.Equals(AssetIntakePolicy.MediaType(kind), StringComparison.OrdinalIgnoreCase))
        {
            return ApiProblems.Create(context, 415, "unsupported_media_type", "Use the asset kind's supported media type");
        }

        // Read only after authorization and stop at the same cap even for chunked requests
        using var buffer = new MemoryStream();
        var chunk = new byte[64 * 1024];
        int count;

        while ((count = await context.Request.Body.ReadAsync(chunk, token)) != 0)
        {
            if (buffer.Length + count > AssetIntakePolicy.MaxBytes)
                return ApiProblems.Create(context, 413, "asset_too_large", "Asset exceeds the 20 MB limit");

            await buffer.WriteAsync(chunk.AsMemory(0, count), token);
        }

        if (buffer.Length == 0)
            return Invalid(context);

        var actor = context.Features.Get<CurrentAccount>()!.UserId;
        await using var transaction = await database.Database.BeginTransactionAsync(token);

        if (await RecheckAdministratorAsync(context, access, token) is { } denied)
            return denied;

        // Validation or storage unavailability leaves no approved entry and must remain retryable to the client
        var result = await service.SubmitAsync(name, kind, category, buffer.ToArray(), actor, metadata, token, displayName, tags);
        if (await RecheckAdministratorAsync(context, access, token) is { } changed)
            return changed;

        if (result is { QuotaExceeded: true })
        {
            return ApiProblems.Create(context, 409, "asset_quota_exceeded", "Retained asset capacity is full; ask an operator to increase storage capacity");
        }

        if (result is null)
            return ApiProblems.Create(context, 503, "asset_intake_unavailable", "Asset validation or storage is unavailable");

        var record = result.Value.Record!;
        if (replaces is { } originalId)
        {
            if (record.Status != "approved")
                return ApiProblems.Create(context, 400, "invalid_replacement", "Choose a valid file for the new asset type");
            if (!result.Value.Created)
                return ApiProblems.Create(context, 409, "replacement_exists", "This file, name and category already have a catalogue entry");
            var replacement = await service.ReplaceTypeAsync(originalId, record, token);
            if (await RecheckAdministratorAsync(context, access, token) is { } revoked)
                return revoked;
            if (replacement is null)
                return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing its type");
            record = replacement;
        }

        await transaction.CommitAsync(token);

        if (await RecheckAdministratorAsync(context, access, token) is not null)
            return CommittedWrite.WithoutRepresentation(context);

        return Results.Json(record, statusCode: result.Value.Created ? StatusCodes.Status201Created : StatusCodes.Status200OK);
    }

    private static async Task<IResult?> RecheckAdministratorAsync(HttpContext context, ProjectAccessService access, CancellationToken token)
    {
        var account = await access.ResolveCurrentAccountAsync(context, token);

        if (account is null)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        if (account.MustChangePassword)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired);

        return account.Role == ApplicationRoles.Administrator ? null
            : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
    }

    private static bool ValidReview(AssetReviewRequest request) =>
        new[] { request.Source, request.License, request.ReviewNotes }
            .All(value => value is null || (value.Length <= 2000 && !value.Any(char.IsControl)));

    private static IResult Invalid(HttpContext context) => ApiProblems.Create(context, 400, "invalid_asset_input", "Check the asset file and metadata");
}
