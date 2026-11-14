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
        var legacy = operationId is null;
        // Legacy requests have no operation ID; reserve the asset ID as their stable identity.
        var key = operationId ?? id;
        await using var transaction = await database.Database.BeginTransactionAsync(token);
        if (await RecheckAdministratorAsync(context, access, token) is { } denied) { return denied; }

        var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
        // An absent operation needs a durable fence so a delayed removal cannot apply after reconciliation.
        var inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO asset_removal_receipts (actor_id, operation_id, asset_id, applied)
            SELECT {actor}, {key}, id, false FROM asset_candidates WHERE id = {id}
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            """, token);
        var created = inserted == 1;
        // Preserve historical bindings before enforcing the legacy asset-ID reservation on new ones.
        if (created && key != id && await database.AssetCandidates.AnyAsync(asset => asset.Id == key, token))
        { return ApiProblems.Create(context, 409, "asset_removal_conflict", "This removal request cannot be applied to the asset"); }
        var receipt = await database.Set<AssetRemovalReceipt>().SingleOrDefaultAsync(row =>
            row.ActorId == actor && row.OperationId == key, token);
        if (receipt is null) { return ApiProblems.Create(context, 404, "asset_not_found", "Asset is unavailable"); }
        if (receipt.AssetId != id || (!reconcile && !created && !receipt.Applied))
        { return ApiProblems.Create(context, 409, "asset_removal_conflict", "This removal request cannot be applied to the asset"); }
        if (reconcile && created && key == id
            && await database.AssetCandidates.Where(asset => asset.Id == id).Select(asset => asset.RemovedFromProjects).SingleAsync(token))
        { return ApiProblems.Create(context, 409, "asset_removal_history_unavailable", "Historical removal cannot be attributed to this operation"); }
        if (legacy && receipt.Applied)
        { return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing it"); }

        IResult result;
        var preferCreated = !legacy && context.Request.Headers["Prefer"].ToString().Split(',')
            .Any(value => value.Trim().Equals("spatia-created-status", StringComparison.OrdinalIgnoreCase));
        if (reconcile)
        {
            result = Results.Ok(new { assetId = id, operationId = key, outcome = receipt.Applied ? "removed" : "notApplied" });
        }
        else
        {
            AssetAdministrationRecord? removed;
            if (receipt.Applied)
            {
                removed = await service.ReadRecordAsync(id, token);
            }
            else
            {
                removed = await service.RemoveAsync(id, documents, token);
                if (removed is null) { return ApiProblems.Create(context, 409, "asset_conflict", "Reload the asset before changing it"); }
                receipt.Applied = true;
                await database.SaveChangesAsync(token);
            }
            result = Results.Json(removed, statusCode: created && preferCreated ? 201 : 200);
        }

        if (await RecheckAdministratorAsync(context, access, token) is { } changed) { return changed; }
        await transaction.CommitAsync(token);
        token.ThrowIfCancellationRequested();
        if (await RecheckAdministratorAsync(context, access, token) is not null)
        { return CommittedWrite.WithoutRepresentation(context); }
        if (!reconcile)
        {
            context.Response.Headers["X-Spatia-Operation-Id"] = key.ToString("D");
            if (preferCreated) { context.Response.Headers["Preference-Applied"] = "spatia-created-status"; }
        }
        return result;
    }
}
