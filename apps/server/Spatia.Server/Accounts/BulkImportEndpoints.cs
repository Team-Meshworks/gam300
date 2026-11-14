using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

public static partial class AccountDirectoryEndpoints
{
    private const int HandoffHours = 24;
    private enum BulkAction { Submit, Recover, Acknowledge, Abandon }
    private sealed record EmptyBulkRequest;
    private sealed record BulkItem(Guid OperationId, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, int CreatedCount);
    private sealed record BulkCreated(Guid UserId, string UserName, string? DisplayName, string Role);
    private sealed record BulkHandoff(Guid UserId, string Password, string? SecurityStamp);
    private sealed record BulkCredential(Guid UserId, string UserName, string Password);

    private static void MapBulkImports(RouteGroupBuilder group)
    {
        group.MapGet("/organizations/{orgId:guid}/bulk-imports", ListBulkImportsAsync);
        const string path = "/organizations/{orgId:guid}/bulk-imports/{operationId:guid}";
        group.MapPut(path, (Guid orgId, Guid operationId, ProvisionAccountRequest[] rows, HttpContext context,
            ApplicationDbContext db, AccountAdministrationService administration, CurrentAccountResolver accounts,
            IDataProtectionProvider protection, TimeProvider clock, CancellationToken token) =>
            BulkImportAsync(orgId, operationId, BulkAction.Submit, rows, context, db, administration, accounts, protection, clock, token))
            .WithMetadata(new RequestSizeLimitAttribute(1024 * 1024))
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        foreach (var (suffix, action) in new[] { ("receipt", BulkAction.Recover), ("acknowledge", BulkAction.Acknowledge), ("abandon", BulkAction.Abandon) })
        {
            group.MapPost(path + "/" + suffix, (Guid orgId, Guid operationId, EmptyBulkRequest request, HttpContext context,
                ApplicationDbContext db, AccountAdministrationService administration, CurrentAccountResolver accounts,
                IDataProtectionProvider protection, TimeProvider clock, CancellationToken token) =>
                BulkImportAsync(orgId, operationId, action, null, context, db, administration, accounts, protection, clock, token))
                .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        }
    }

    private static async Task<IResult> ListBulkImportsAsync(Guid orgId, HttpContext context, ApplicationDbContext db,
        CurrentAccountResolver accounts, TimeProvider clock, CancellationToken token)
    {
        var page = ReadQuery(context.Request.Query, users: false);
        if (page is null || page.Limit > 50 || context.Request.Query.Keys.Any(key => key is not ("limit" or "cursor")))
        { return InvalidQuery(context); }
        await using var transaction = await db.Database.BeginTransactionAsync(token);
        if (await AuthorizeAsync(context, accounts, token) is { } denied) { return denied; }
        if (!await db.Organizations.AnyAsync(row => row.Id == orgId && row.IsActive, token)) { return MissingBulk(context); }
        var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
        var now = clock.GetUtcNow();
        await PruneBulkHandoffsAsync(db, now, token);
        var results = await db.Database.SqlQuery<BulkItem>($"""
            SELECT operation_id AS "OperationId", expires_at - interval '1 hour' * {HandoffHours} AS "CreatedAt",
                   expires_at AS "ExpiresAt", jsonb_array_length(created_accounts) AS "CreatedCount"
            FROM bulk_import_receipts
            WHERE actor_id = {actor} AND organization_id = {orgId} AND operation_id > {page.Cursor ?? Guid.Empty}
              AND protected_intent IS NOT NULL AND NOT acknowledged AND expires_at > {now}
            ORDER BY operation_id LIMIT {page.Limit + 1}
            """).ToArrayAsync(token);
        if (await AuthorizeAsync(context, accounts, token) is { } revoked) { return revoked; }
        return await CompleteAsync(context, transaction, Results.Ok(new
        {
            items = results.Take(page.Limit),
            nextCursor = results.Length > page.Limit ? results[page.Limit - 1].OperationId : (Guid?)null,
        }), token);
    }

    private static async Task<IResult> BulkImportAsync(Guid orgId, Guid operationId, BulkAction action, ProvisionAccountRequest[]? rows,
        HttpContext context, ApplicationDbContext db, AccountAdministrationService administration, CurrentAccountResolver accounts,
        IDataProtectionProvider protection, TimeProvider clock, CancellationToken token)
    {
        if (operationId == Guid.Empty || orgId == Guid.Empty || (action == BulkAction.Submit &&
            (!AccountAdministrationService.IsValidBulk(rows) || rows![0].OrgId != orgId)))
        { return ApiProblems.Create(context, 400, "invalid_account_input", "Check the supplied account details and organization."); }
        await using var transaction = await db.Database.BeginTransactionAsync(token);
        // The same writer lock covers legacy provisioning, roster changes, organization deletion and the absence fence.
        await db.Database.ExecuteSqlRawAsync("""LOCK TABLE "AspNetUserRoles" IN SHARE ROW EXCLUSIVE MODE""", token);
        if (await AuthorizeAsync(context, accounts, token) is { } failure) { return failure; }
        var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
        var now = clock.GetUtcNow();
        var receipts = db.Set<BulkImportReceipt>();
        await PruneBulkHandoffsAsync(db, now, token);
        var receipt = await receipts.SingleOrDefaultAsync(row => row.ActorId == actor && row.OrganizationId == orgId
            && row.OperationId == operationId, token);
        var fresh = receipt is null;
        if (fresh && action is BulkAction.Recover or BulkAction.Acknowledge) { return MissingBulk(context); }
        if (fresh && !await db.Organizations.AnyAsync(row => row.Id == orgId && row.IsActive, token))
        {
            return action == BulkAction.Submit
                ? ApiProblems.Create(context, 422, "organization_unavailable", "Choose an active organization.")
                : MissingBulk(context);
        }
        if (fresh)
        {
            receipt = new BulkImportReceipt
            {
                ActorId = actor,
                OrganizationId = orgId,
                OperationId = operationId,
                CreatedJson = "[]",
                ExpiresAt = now.AddHours(HandoffHours),
            };
            receipts.Add(receipt);
        }
        else if (receipt!.ProtectedIntent is null && action != BulkAction.Abandon)
        { return ApiProblems.Create(context, 409, "bulk_import_abandoned", "This import was canceled."); }
        if (action == BulkAction.Abandon && receipt!.ProtectedIntent is not null)
        { return ApiProblems.Create(context, 409, "bulk_import_committed", "This import already committed. Recover its receipt."); }

        var protector = protection.CreateProtector("Spatia.BulkImport.v1", actor.ToString("D"), orgId.ToString("D"), operationId.ToString("D"));
        var handoff = protector.CreateProtector("handoff");
        if (action == BulkAction.Submit)
        {
            var intent = protector.CreateProtector("intent");
            var digest = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows!));
            if (fresh)
            {
                var outcome = await administration.ProvisionBulkRowsAsync(rows!, token);
                if (!outcome.Result.Succeeded) { return AccountAdministrationEndpoints.ToProblem(context, outcome.Result); }
                var created = outcome.Accounts!.Select(row => new BulkCreated(row.UserId, row.UserName, row.DisplayName, row.Role)).ToArray();
                receipt!.ProtectedIntent = intent.Protect(digest);
                receipt.CreatedJson = JsonSerializer.Serialize(created);
                if (created.Length > 0)
                {
                    var originals = rows!.DistinctBy(row => row.UserName, StringComparer.Ordinal).ToDictionary(row => row.UserName, StringComparer.Ordinal);
                    var secrets = created.Select(row => new BulkHandoff(row.UserId, originals[row.UserName].InitialPassword,
                        db.Users.Local.Single(user => user.Id == row.UserId).SecurityStamp));
                    receipt.ProtectedHandoff = handoff.Protect(JsonSerializer.SerializeToUtf8Bytes(secrets));
                }
            }
            else if (!CryptographicOperations.FixedTimeEquals(intent.Unprotect(receipt!.ProtectedIntent!), digest))
            { return ApiProblems.Create(context, 409, "bulk_import_conflict", "This import identifier belongs to different input."); }
        }
        if (action == BulkAction.Acknowledge)
        {
            receipt!.Acknowledged = true;
            receipt.ProtectedHandoff = null;
        }
        List<BulkCredential> credentials = [];
        await db.SaveChangesAsync(token);
        IResult result = Results.NoContent();
        if (action is BulkAction.Submit or BulkAction.Recover)
        {
            var created = JsonSerializer.Deserialize<BulkCreated[]>(receipt!.CreatedJson)!;
            if (receipt.ProtectedHandoff is not null && receipt.ExpiresAt > clock.GetUtcNow())
            {
                var ids = created.Select(row => row.UserId).Append(actor).ToArray();
                // A first password change can race recovery independently of the admin role lock.
                // Pin the current stamps through commit; an old temporary password cannot survive a completed reset.
                await db.Database.SqlQuery<Guid>($"""
                    SELECT "Id" AS "Value" FROM "AspNetUsers" WHERE "Id" = ANY({ids}) ORDER BY "Id" FOR SHARE
                    """).ToListAsync(token);
                var current = await (from user in db.Users.AsNoTracking()
                                     join member in db.OrganizationMemberships on user.Id equals member.UserId
                                     join organization in db.Organizations on member.OrganizationId equals organization.Id
                                     where ids.Contains(user.Id) && member.OrganizationId == orgId && organization.IsActive
                                         && user.IsActive && !user.IsDeleted && user.MustChangePassword
                                     select new { user.Id, user.UserName, user.SecurityStamp }).ToDictionaryAsync(user => user.Id, token);
                var protectedRows = JsonSerializer.Deserialize<BulkHandoff[]>(handoff.Unprotect(receipt.ProtectedHandoff))!;
                foreach (var row in protectedRows)
                {
                    if (current.TryGetValue(row.UserId, out var user) && user.SecurityStamp == row.SecurityStamp && user.SecurityStamp is not null)
                    { credentials.Add(new(row.UserId, user.UserName!, row.Password)); }
                }
            }
            result = Results.Json(new { operationId, orgId, created, credentials, receipt.ExpiresAt, receipt.Acknowledged },
                statusCode: fresh ? StatusCodes.Status201Created : StatusCodes.Status200OK);
        }
        if (await AuthorizeAsync(context, accounts, token) is { } revoked) { return revoked; }
        var completed = await CompleteAsync(context, transaction, result, token);
        if (receipt!.ExpiresAt <= clock.GetUtcNow()) { credentials.Clear(); }
        return completed;
    }

    private static Task PruneBulkHandoffsAsync(ApplicationDbContext db, DateTimeOffset now, CancellationToken token) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE bulk_import_receipts SET protected_handoff = NULL
            WHERE (actor_id, organization_id, operation_id) IN (
                SELECT actor_id, organization_id, operation_id FROM bulk_import_receipts
                WHERE protected_handoff IS NOT NULL AND expires_at <= {now}
                ORDER BY expires_at, actor_id, organization_id, operation_id LIMIT 100 FOR UPDATE SKIP LOCKED
            )
            """, token);

    private static IResult MissingBulk(HttpContext context) =>
        ApiProblems.Create(context, 404, "bulk_import_not_found", "This import is unavailable.");
}
