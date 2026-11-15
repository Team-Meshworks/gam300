using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Hosting;

internal static class LegacyCreationResolutions
{
    internal static IResult? Bind(HttpContext context, Guid? supplied, CreationGuard? guard,
        out Guid operationId, out LegacyCreationResolution? resolution)
    {
        operationId = Guid.Empty;
        resolution = null;

        if (!HttpMethods.IsPut(context.Request.Method))
        {
            if (supplied is null && guard is null && !context.Request.Headers.ContainsKey("Idempotency-Key"))
            {
                resolution = new(false, null, null);
                return null;
            }

            return CreationReceipts.BindOperationId(context, supplied, out operationId);
        }

        var query = context.Request.Query;

        if (supplied is not null || guard is not null || context.Request.Headers.ContainsKey("Idempotency-Key")
            || query.Count != 1 || query.Any(pair => pair.Value.Count != 1 || pair.Key is not ("useExisting" or "createAfter")))
        {
            return Invalid(context);
        }

        if (query.TryGetValue("useExisting", out var existing) && ParseId(existing[0], out var existingId))
        {
            resolution = new(true, existingId, null);
            return null;
        }

        if (query.TryGetValue("createAfter", out var previous))
        {
            if (previous[0] == "initial")
            {
                resolution = new(true, null, null);
                return null;
            }

            if (ParseId(previous[0], out var previousId))
            {
                resolution = new(true, null, previousId);
                return null;
            }
        }

        return Invalid(context);
    }

    private static bool ParseId(string? raw, out Guid value)
    {
        value = Guid.Empty;
        return raw is { Length: 36 } && Guid.TryParseExact(raw, "D", out value) && value != Guid.Empty;
    }

    internal static byte[] ProjectDigest(CreateProjectRequest request) => Digest("project", request.Document is null ? "project" : "import", null,
        new
        {
            title = request.Title,
            orgId = request.OrgId,
            environmentAssetId = request.EnvironmentAssetId,
            document = request.Document,
            image = request.Image is { } image ? new
            {
                type = image.Type,
                contentType = image.ContentType,
                data = image.Data
            } : null,
        });

    internal static byte[] DuplicateDigest(Guid sourceProjectId, DuplicateProjectRequest request) => Digest("duplicate", "duplicate", sourceProjectId,
        new
        {
            expectedRevision = request.ExpectedRevision,
            title = request.Title
        });

    internal static byte[] ClassDigest(string? name, Guid? orgId, Guid[]? managers) => Digest("class", "class", null,
        new
        {
            name,
            orgId,
            managedByUserIds = managers
        });

    private static byte[] Digest<T>(string kind, string purpose, Guid? sourceProjectId, T body) =>
        CreationReceipts.Digest(new
        {
            domain = "spatia.legacy-creation.v1",
            kind,
            purpose,
            sourceProjectId,
            body
        });

    internal static async Task<(LegacyCreationBinding? Binding, IResult? Failure)> LookupAsync(HttpContext context,
        ApplicationDbContext database, Guid actorId, byte[]? digest, LegacyCreationResolution? resolution, CancellationToken cancellationToken)
    {
        if (digest is null)
            return (null, null);

        var binding = await database.Set<LegacyCreationBinding>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.ActorId == actorId && row.IntentDigest == digest, cancellationToken);
        return (binding, binding is null && !resolution!.IsDecision ? Required(context) : null);
    }

    internal static void Stage(ApplicationDbContext database, Guid actorId, byte[] digest, string kind,
        string purpose, Guid organizationId, Guid? sourceProjectId, Guid resourceId, Guid? operationId, Guid? previousOperationId)
    {
        var binding = new LegacyCreationBinding
        {
            ActorId = actorId,
            IntentDigest = digest,
            Kind = kind,
            Purpose = purpose,
            OrganizationId = organizationId,
            SourceProjectId = sourceProjectId,
            ResourceId = resourceId,
            OperationId = operationId,
            PreviousOperationId = previousOperationId,
        };
        database.Set<LegacyCreationBinding>().Add(binding);
    }

    internal static IResult Required(HttpContext context)
    {
        var url = context.Request.Path.Value!.TrimEnd('/') + "/legacy-resolution";
        context.Response.Headers.Link = $"<{url}>; rel=\"related\"";
        var result = ApiProblems.Create(context, 400, "creation_operation_id_required",
            "Supply and reuse a stable operation ID, or explicitly resolve this legacy request at resolutionUrl before retrying.");
        result.ProblemDetails.Extensions["resolutionUrl"] = url;
        return result;
    }

    internal static IResult Conflict(HttpContext context) => ApiProblems.Create(context, 409,
        "legacy_creation_resolution_conflict", "This legacy request already has a different immutable resolution.");

    private static IResult Invalid(HttpContext context) => ApiProblems.Create(context, 400,
        "invalid_legacy_creation_resolution", "Supply the original unkeyed body and exactly one useExisting UUID or createAfter=initial|UUID decision.");

    internal static async Task<IResult> ReplayCreatedAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, IDbContextTransaction transaction, CurrentAccount account, LegacyCreationResolution resolution,
        LegacyCreationBinding binding, CreationReceipt? receipt, CancellationToken cancellationToken)
    {
        if (receipt?.ResponseJson is null)
        {
            return binding.Kind == "class" ? ApiProblems.Create(context, 404, "class_not_found", "The class is unavailable.")
                : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound);
        }

        if (await CreationReceipts.AccessFailureAsync(context, database, access, receipt, cancellationToken) is { } failure)
            return failure;

        if (!resolution.Matches(binding))
            return Conflict(context);

        if (await CreationReceipts.RevalidateAsync(context, access, account, cancellationToken) is { } changed)
            return changed;

        return await CompleteAsync(context, transaction, Results.Content(receipt.ResponseJson, "application/json", statusCode: 200),
            "created", CreationReceipts.Location(binding.Kind, binding.ResourceId), false, cancellationToken);
    }

    internal static async Task<IResult> CompleteAsync(HttpContext context, IDbContextTransaction transaction, IResult result,
        string resolution, string location, bool written, CancellationToken cancellationToken)
    {
        if (Expired(context))
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();

        if (Expired(context))
        {
            return written ? CommittedWrite.WithoutRepresentation(context)
                : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);
        }

        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Location = location;
        context.Response.Headers["X-Spatia-Creation-Resolution"] = resolution;
        return result;
    }

    private static bool Expired(HttpContext context) => context.Features.Get<ValidatedAccountSession>() is not { } session
        || session.Clock.GetUtcNow() >= session.ExpiresUtc;
}
