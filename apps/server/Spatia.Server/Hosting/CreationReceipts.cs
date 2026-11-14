using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Hosting;

internal static class CreationReceipts
{
    // Bind a retry to its original request without retaining its document or image in the receipt.
    internal static byte[] Digest<T>(T request) => SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request));

    // Normalize both wire forms before digesting so a retry can use either form.
    internal static IResult? BindOperationId(HttpContext context, Guid? supplied, out Guid operationId)
    {
        operationId = supplied ?? Guid.Empty;
        if (supplied == Guid.Empty) { return InvalidOperationId(context); }
        if (context.Request.Headers.TryGetValue("Idempotency-Key", out var values))
        {
            if (values.Count != 1 || values[0] is not { Length: 36 } raw || !Guid.TryParseExact(raw, "D", out var headerId)
                || headerId == Guid.Empty || (supplied is { } bodyId && bodyId != headerId))
            { return InvalidOperationId(context); }
            operationId = headerId;
        }
        return operationId != Guid.Empty ? null : ApiProblems.Create(context, 400, "creation_operation_id_required",
            "Supply a stable operationId UUID in JSON or the Idempotency-Key header, and reuse it for retries.");
    }

    private static IResult InvalidOperationId(HttpContext context) => ApiProblems.Create(context, 400, "invalid_creation_operation_id",
        "Use one non-empty UUID operationId or Idempotency-Key header; when both are supplied they must match.");

    internal static bool ValidPurpose(string? purpose) => purpose is "project" or "class" or "duplicate" or "import" or "assignment-source";

    internal static bool ValidGuard(CreationGuard? guard, string kind, bool imported = false) => guard is null
        || (guard.PreviousOperationId != Guid.Empty && kind switch
        {
            "class" => guard.Purpose == "class",
            "duplicate" => guard.Purpose == "duplicate",
            _ => imported ? guard.Purpose == "import" : guard.Purpose is "project" or "assignment-source",
        });

    internal static Task LockPurposeAsync(ApplicationDbContext database, Guid actorId, string purpose, CancellationToken cancellationToken)
    {
        // Lock the empty generation too, so concurrent first creates cannot both pass the same guard.
        var key = BinaryPrimitives.ReadInt64LittleEndian(SHA256.HashData(Encoding.UTF8.GetBytes($"creation-purpose:{actorId:D}:{purpose}")));
        return database.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock({key})", cancellationToken);
    }

    internal static async Task<IResult?> CheckGuardAsync(HttpContext context, ApplicationDbContext database, Guid actorId,
        string purpose, CreationGuard? guard, CancellationToken cancellationToken)
    {
        if (guard is null) { return null; }
        var receipts = database.Set<CreationReceipt>().Where(row => row.ActorId == actorId && row.Purpose == purpose);
        var latest = await receipts.OrderByDescending(row => row.Sequence).Select(row => (Guid?)row.OperationId).FirstOrDefaultAsync(cancellationToken);
        return latest == guard.PreviousOperationId && !await receipts.AnyAsync(row => !row.Acknowledged, cancellationToken) ? null
            : ApiProblems.Create(context, 409, "creation_state_changed", "A creation operation changed. Recover it before creating another resource.");
    }

    internal static async Task<CreationReceipt?> FindAsync(ApplicationDbContext database, Guid actorId, Guid operationId,
        CancellationToken cancellationToken)
    {
        // Serialize even the first request, before a receipt exists to lock.
        var key = BinaryPrimitives.ReadInt64LittleEndian(SHA256.HashData(Encoding.UTF8.GetBytes($"creation:{actorId:D}:{operationId:D}")));
        await database.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock({key})", cancellationToken);
        return await database.Set<CreationReceipt>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.ActorId == actorId && row.OperationId == operationId, cancellationToken);
    }

    internal static bool Matches(CreationReceipt receipt, string kind, byte[] digest) =>
        receipt.Kind == kind && receipt.RequestDigest.AsSpan().SequenceEqual(digest);

    internal static async Task<IResult?> RevalidateAsync(HttpContext context, ProjectAccessService access,
        CurrentAccount original, CancellationToken cancellationToken)
    {
        var current = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (current is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (current.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        return current.Role == original.Role && current.OrganizationId == original.OrganizationId ? null
            : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);
    }

    internal static async Task<IResult?> AccessFailureAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CreationReceipt receipt, CancellationToken cancellationToken, bool requireSource = false)
    {
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
        if (requireSource && receipt.Kind == "duplicate")
        {
            if (receipt.SourceProjectId is not { } source) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }
            var authorization = await access.LockAsync(context, source, ProjectLockPurpose.EditDraft, cancellationToken);
            if (authorization.Failure is { } failure) { return ProjectHttpResults.FromAccessFailure(context, failure); }
        }
        if (receipt.Kind != "class")
        {
            return await access.VisibleProjects(account).AnyAsync(row => row.Id == receipt.ResourceId, cancellationToken)
                ? null : ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound);
        }
        return await database.Classrooms.AnyAsync(row => row.Id == receipt.ResourceId
            && (account.Role == ApplicationRoles.Administrator || (row.OrganizationId == account.OrganizationId
                && account.Role == ApplicationRoles.Educator && database.ClassroomMembers.Any(member => member.ClassroomId == row.Id
                    && member.UserId == account.UserId && member.RoleId == ApplicationRoles.EducatorId && member.IsActive))), cancellationToken)
            ? null : ApiProblems.Create(context, 404, "class_not_found", "The class is unavailable.");
    }

    internal static void Stage<T>(ApplicationDbContext database, Guid actorId, Guid operationId, string kind,
        byte[] digest, Guid resourceId, T response, string? purpose = null, Guid? sourceProjectId = null)
    {
        database.Set<CreationReceipt>().Add(new CreationReceipt
        {
            ActorId = actorId,
            OperationId = operationId,
            Purpose = purpose ?? kind,
            SourceProjectId = sourceProjectId,
            Kind = kind,
            RequestDigest = digest,
            ResourceId = resourceId,
            ResponseJson = JsonSerializer.Serialize(response, JsonSerializerOptions.Web),
        });
    }

    internal static async Task<IResult> CompleteReplayAsync(HttpContext context, IDbContextTransaction transaction,
        CreationReceipt receipt, CancellationToken cancellationToken)
    {
        if (Expired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (Expired(context)) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Location = Location(receipt.Kind, receipt.ResourceId);
        return Results.Content(receipt.ResponseJson, "application/json", statusCode: 200);
    }

    private static bool Expired(HttpContext context) => context.Features.Get<ValidatedAccountSession>() is not { } session
        || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    internal static string Location(string kind, Guid id) => $"{ApiV1Endpoints.Prefix}/{(kind == "class" ? "classes" : "projects")}/{id:D}";

    internal static IResult Conflict(HttpContext context) =>
        ApiProblems.Create(context, 409, "operation_conflict", "This operation ID was already used for a different request.");
}
