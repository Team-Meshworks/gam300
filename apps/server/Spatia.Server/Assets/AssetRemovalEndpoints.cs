using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Assets;

public static partial class AssetAdministrationEndpoints
{
    private const string RemovalPath = "/{id:guid}/removals/{operationId:guid}";
    private sealed record EmptyRemovalRequest;

    private static void MapRemovalReceipts(RouteGroupBuilder group)
    {
        group.MapPut(RemovalPath, (Guid id, Guid operationId, EmptyRemovalRequest _, HttpContext context,
            AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access,
            ProjectDocumentService documents, CancellationToken token) =>
            RemoveAsync(id, operationId, false, context, service, database, access, documents, token));
        group.MapPost(RemovalPath + "/reconcile", (Guid id, Guid operationId, EmptyRemovalRequest _, HttpContext context,
            AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access,
            ProjectDocumentService documents, CancellationToken token) =>
            RemoveAsync(id, operationId, true, context, service, database, access, documents, token));
    }

    private static async Task<IResult> RemoveAsync(Guid id, Guid? operationId, bool reconcile, HttpContext context,
        AssetAdministrationService service, ApplicationDbContext database, ProjectAccessService access,
        ProjectDocumentService documents, CancellationToken token)
    {
        if (operationId == Guid.Empty) { return Invalid(context); }
        await using var transaction = await database.Database.BeginTransactionAsync(token);
        if (await RecheckAdministratorAsync(context, access, token) is { } denied) { return denied; }

        AssetRemovalReceipt? receipt = null;
        if (operationId is { } key)
        {
            var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
            // An absent operation needs a durable fence so a delayed removal cannot apply after reconciliation.
            var inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO asset_removal_receipts (actor_id, operation_id, asset_id, applied)
                SELECT {actor}, {key}, id, false FROM asset_candidates WHERE id = {id}
                ON CONFLICT (actor_id, operation_id) DO NOTHING
                """, token);
            receipt = await database.Set<AssetRemovalReceipt>().SingleOrDefaultAsync(row =>
                row.ActorId == actor && row.OperationId == key, token);
            if (receipt is null) { return ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable"); }
            if (receipt.AssetId != id || (!reconcile && inserted == 0 && !receipt.Applied))
            { return ApiProblems.Create(context, 409, "asset_removal_conflict", "This removal request cannot be applied to the asset"); }
        }

        IResult result;
        if (reconcile)
        {
            result = Results.Ok(new { assetId = id, operationId, outcome = receipt!.Applied ? "removed" : "notApplied" });
        }
        else
        {
            AssetAdministrationRecord? removed;
            if (receipt is { Applied: true })
            {
                removed = await service.ReadRecordAsync(id, token);
            }
            else
            {
                removed = await service.RemoveAsync(id, documents, token);
                if (removed is null) { return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing it"); }
                if (receipt is not null)
                {
                    receipt.Applied = true;
                    await database.SaveChangesAsync(token);
                }
            }
            result = Results.Ok(removed);
        }

        if (await RecheckAdministratorAsync(context, access, token) is { } changed) { return changed; }
        await transaction.CommitAsync(token);
        token.ThrowIfCancellationRequested();
        if (context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc)
        { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
        if (!reconcile && operationId is { } confirmed) { context.Response.Headers["X-Spatia-Operation-Id"] = confirmed.ToString("D"); }
        return result;
    }
}
