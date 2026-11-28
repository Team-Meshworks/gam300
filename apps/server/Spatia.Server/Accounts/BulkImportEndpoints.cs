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

    private enum BulkAction
    {
        Submit, Recover, Acknowledge, Abandon
    }

    private sealed record EmptyBulkRequest;
    private sealed record BulkItem(Guid OperationId, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, int CreatedCount, byte[]? ProtectedHandoff);
    private sealed record BulkCreated(Guid UserId, string UserName, string? DisplayName, string Role);
    private sealed record BulkHandoff(Guid UserId, string Password, string? SecurityStamp);
    private sealed record BulkCredential(Guid UserId, string UserName, string Password);

    internal static Task<IResult> LegacyBulkImportAsync(ProvisionAccountRequest[] rows, HttpContext context,
        ApplicationDbContext db, AccountAdministrationService administration, CurrentAccountResolver accounts,
        IDataProtectionProvider protection, TimeProvider clock, CancellationToken token) =>
        BulkImportAsync(rows.FirstOrDefault()?.OrgId ?? Guid.Empty, Guid.NewGuid(), BulkAction.Submit, rows,
            context, db, administration, accounts, protection, clock, token, legacy: true);

    private static void MapBulkImports(RouteGroupBuilder group)
    {
        group.MapGet("/organizations/{orgId:guid}/bulk-imports", ListBulkImportsAsync);
        group.MapPost("/organizations/{orgId:guid}/bulk-imports/download", DownloadBulkImportsAsync)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
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
        CurrentAccountResolver accounts, IDataProtectionProvider protection, TimeProvider clock, CancellationToken token)
    {
        var page = ReadQuery(context.Request.Query, users: false);

        if (page is null || page.Limit > 50 || context.Request.Query.Keys.Any(key => key is not ("limit" or "cursor")))
            return InvalidQuery(context);

        await using var transaction = await db.Database.BeginTransactionAsync(token);

        if (await AuthorizeAsync(context, accounts, token) is { } denied)
            return denied;

        if (!await db.Organizations.AnyAsync(row => row.Id == orgId && row.IsActive, token))
            return MissingBulk(context);

        var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
        var now = clock.GetUtcNow();
        await PruneBulkHandoffsAsync(db, now, token);
        var results = await db.Database.SqlQuery<BulkItem>($"""
            SELECT operation_id AS "OperationId", expires_at - interval '1 hour' * {HandoffHours} AS "CreatedAt",
                   expires_at AS "ExpiresAt", jsonb_array_length(created_accounts) AS "CreatedCount", protected_handoff AS "ProtectedHandoff"
            FROM bulk_import_receipts
            WHERE actor_id = {actor} AND organization_id = {orgId} AND operation_id > {page.Cursor ?? Guid.Empty}
              AND protected_intent IS NOT NULL AND NOT acknowledged AND expires_at > {now}
            ORDER BY operation_id LIMIT {page.Limit + 1}
            """).ToArrayAsync(token);

        var summaries = results.Take(page.Limit).Select(item =>
        {
            var rows = item.ProtectedHandoff is null ? Array.Empty<BulkHandoff>() :
                ReadHandoff(protection, actor, orgId, item.OperationId, item.ProtectedHandoff);
            return (item, rows);
        }).ToArray();
        var ids = summaries.SelectMany(entry => entry.rows.Select(row => row.UserId)).Distinct().ToArray();
        var eligible = await EligibleBulkUsers(db, orgId, ids).ToDictionaryAsync(user => user.Id, token);

        if (await AuthorizeAsync(context, accounts, token) is { } revoked)
            return revoked;

        return await CompleteAsync(context, transaction, Results.Ok(new
        {
            items = summaries.Select(entry => new
            {
                entry.item.OperationId, entry.item.CreatedAt, entry.item.ExpiresAt, entry.item.CreatedCount,
                hasDownload = entry.item.ExpiresAt > clock.GetUtcNow() && entry.rows.Any(row => IsEligible(row, eligible)),
            }).ToArray(),
            nextCursor = results.Length > page.Limit ? results[page.Limit - 1].OperationId : (Guid?)null,
        }), token);
    }

    private static async Task<IResult> DownloadBulkImportsAsync(Guid orgId, EmptyBulkRequest request, HttpContext context,
        ApplicationDbContext db, CurrentAccountResolver accounts, IDataProtectionProvider protection, TimeProvider clock, CancellationToken token)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(token);
        if (await AuthorizeAsync(context, accounts, token) is { } denied) return denied;
        var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
        var now = clock.GetUtcNow();
        var receipts = await db.Set<BulkImportReceipt>().FromSqlInterpolated($"""
            SELECT * FROM bulk_import_receipts WHERE actor_id = {actor} AND organization_id = {orgId}
              AND NOT acknowledged AND protected_handoff IS NOT NULL AND expires_at > {now}
            ORDER BY operation_id FOR SHARE
            """).AsNoTracking().ToArrayAsync(token);
        var batches = receipts.Select(item => (item, rows: ReadHandoff(protection, actor, orgId, item.OperationId, item.ProtectedHandoff!))).ToArray();
        var ids = batches.SelectMany(batch => batch.rows.Select(row => row.UserId)).Append(actor).Distinct().ToArray();
        await db.Database.SqlQuery<Guid>($"""
            SELECT "Id" AS "Value" FROM "AspNetUsers" WHERE "Id" = ANY({ids}) ORDER BY "Id" FOR SHARE
            """).ToListAsync(token);
        var eligible = await EligibleBulkUsers(db, orgId, ids).ToDictionaryAsync(user => user.Id, token);
        if (await AuthorizeAsync(context, accounts, token) is { } revoked) return revoked;
        var result = batches.Where(batch => batch.item.ExpiresAt > clock.GetUtcNow()).Select(batch => new
        {
            batch.item.OperationId, orgId, created = JsonSerializer.Deserialize<BulkCreated[]>(batch.item.CreatedJson),
            credentials = batch.rows.Where(row => IsEligible(row, eligible))
                .Select(row => new BulkCredential(row.UserId, eligible[row.UserId].UserName!, row.Password)).ToArray(),
            batch.item.ExpiresAt, batch.item.Acknowledged,
        }).Where(batch => batch.credentials.Length > 0).ToList();
        var response = await CompleteAsync(context, transaction, Results.Ok(result), token, readOnly: true);
        var completedAt = clock.GetUtcNow();
        result.RemoveAll(batch => batch.ExpiresAt <= completedAt);
        return response;
    }

    private static BulkHandoff[] ReadHandoff(IDataProtectionProvider protection, Guid actor, Guid orgId, Guid operationId, byte[] value) =>
        JsonSerializer.Deserialize<BulkHandoff[]>(protection.CreateProtector("Spatia.BulkImport.v1",
            actor.ToString("D"), orgId.ToString("D"), operationId.ToString("D")).CreateProtector("handoff").Unprotect(value))!;

    private static bool IsEligible(BulkHandoff row, Dictionary<Guid, BulkUser> eligible) =>
        eligible.TryGetValue(row.UserId, out var user) && user.SecurityStamp is not null && user.SecurityStamp == row.SecurityStamp;

    private static async Task<IResult> BulkImportAsync(Guid orgId, Guid operationId, BulkAction action, ProvisionAccountRequest[]? rows,
        HttpContext context, ApplicationDbContext db, AccountAdministrationService administration, CurrentAccountResolver accounts,
        IDataProtectionProvider protection, TimeProvider clock, CancellationToken token, bool legacy = false)
    {
        if (operationId == Guid.Empty || orgId == Guid.Empty || (action == BulkAction.Submit &&
            (!AccountAdministrationService.IsValidBulk(rows) || rows![0].OrgId != orgId)))
        {
            return ApiProblems.Create(context, 400, "invalid_account_input", "Check the supplied account details and organization.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync(token);
        // The same writer lock covers legacy provisioning, roster changes, organization deletion and the absence fence.
        await db.Database.ExecuteSqlRawAsync("""LOCK TABLE "AspNetUserRoles" IN SHARE ROW EXCLUSIVE MODE""", token);

        if (await AuthorizeAsync(context, accounts, token) is { } failure)
            return failure;

        var actor = context.Features.Get<ValidatedAccountSession>()!.UserId;
        var now = clock.GetUtcNow();
        var receipts = db.Set<BulkImportReceipt>();
        await PruneBulkHandoffsAsync(db, now, token);
        var receipt = await receipts.SingleOrDefaultAsync(row => row.ActorId == actor && row.OrganizationId == orgId
            && row.OperationId == operationId, token);
        var fresh = receipt is null;

        if (fresh && action is BulkAction.Recover or BulkAction.Acknowledge)
            return MissingBulk(context);

        if (fresh && !legacy && !await db.Organizations.AnyAsync(row => row.Id == orgId && row.IsActive, token))
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
        {
            return ApiProblems.Create(context, 409, "bulk_import_abandoned", "This import was canceled.");
        }

        if (action == BulkAction.Abandon && receipt!.ProtectedIntent is not null)
            return ApiProblems.Create(context, 409, "bulk_import_committed", "This import already committed. Recover its receipt.");

        var protector = protection.CreateProtector("Spatia.BulkImport.v1", actor.ToString("D"), orgId.ToString("D"), operationId.ToString("D"));
        var handoff = protector.CreateProtector("handoff");
        IReadOnlyList<ProvisionedAccount>? legacyAccounts = null;

        if (action == BulkAction.Submit)
        {
            var intent = protector.CreateProtector("intent");
            var digest = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows!));

            if (fresh)
            {
                var outcome = await administration.ProvisionBulkRowsAsync(rows!, token);

                if (!outcome.Result.Succeeded)
                    return AccountAdministrationEndpoints.ToProblem(context, outcome.Result);

                legacyAccounts = outcome.Accounts;
                var created = outcome.Accounts!.Select(row => new BulkCreated(row.UserId, row.UserName, row.DisplayName, row.Role)).ToArray();
                receipt!.ProtectedIntent = intent.Protect(digest);
                receipt.CreatedJson = JsonSerializer.Serialize(created);

                if (created.Length > 0)
                {
                    // Only newly created accounts receive a recoverable handoff of their original temporary passwords.
                    var originals = rows!.DistinctBy(row => row.UserName, StringComparer.Ordinal).ToDictionary(row => row.UserName, StringComparer.Ordinal);
                    var secrets = created.Select(row => new BulkHandoff(row.UserId, originals[row.UserName].InitialPassword,
                        db.Users.Local.Single(user => user.Id == row.UserId).SecurityStamp));
                    receipt.ProtectedHandoff = handoff.Protect(JsonSerializer.SerializeToUtf8Bytes(secrets));
                }
                else if (legacy)
                {
                    db.Entry(receipt).State = EntityState.Detached;
                }
            }
            else if (!CryptographicOperations.FixedTimeEquals(intent.Unprotect(receipt!.ProtectedIntent!), digest))
            {
                return ApiProblems.Create(context, 409, "bulk_import_conflict", "This import identifier belongs to different input.");
            }
        }

        if (action == BulkAction.Acknowledge)
        {
            receipt!.Acknowledged = true;
            receipt.ProtectedHandoff = null;
        }

        List<BulkCredential> credentials = [];
        await db.SaveChangesAsync(token);
        IResult result = legacy ? Results.Json(legacyAccounts, statusCode: legacyAccounts!.Count > 0
            ? StatusCodes.Status201Created : StatusCodes.Status200OK) : Results.NoContent();

        if (!legacy && action is (BulkAction.Submit or BulkAction.Recover))
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
                var current = await EligibleBulkUsers(db, orgId, ids).ToDictionaryAsync(user => user.Id, token);
                var protectedRows = JsonSerializer.Deserialize<BulkHandoff[]>(handoff.Unprotect(receipt.ProtectedHandoff))!;

                foreach (var row in protectedRows)
                {
                    if (current.TryGetValue(row.UserId, out var user) && user.SecurityStamp == row.SecurityStamp && user.SecurityStamp is not null)
                        credentials.Add(new(row.UserId, user.UserName!, row.Password));
                }
            }

            result = Results.Json(new
            {
                operationId,
                orgId,
                created,
                credentials,
                receipt.ExpiresAt,
                receipt.Acknowledged
            },
                statusCode: fresh ? StatusCodes.Status201Created : StatusCodes.Status200OK);
        }

        if (await AuthorizeAsync(context, accounts, token) is { } revoked)
            return revoked;

        var completed = await CompleteAsync(context, transaction, result, token, readOnly: action == BulkAction.Recover);

        if (legacy && legacyAccounts!.Count > 0 && ReferenceEquals(completed, result))
            context.Response.Headers["X-Spatia-Operation-Id"] = operationId.ToString("D");

        if (receipt!.ExpiresAt <= clock.GetUtcNow())
            credentials.Clear();

        return completed;
    }

    private sealed record BulkUser(Guid Id, string? UserName, string? SecurityStamp);

    private static IQueryable<BulkUser> EligibleBulkUsers(ApplicationDbContext db, Guid orgId, Guid[] ids) =>
        from user in db.Users.AsNoTracking()
        join member in db.OrganizationMemberships on user.Id equals member.UserId
        join organization in db.Organizations on member.OrganizationId equals organization.Id
        where ids.Contains(user.Id) && member.OrganizationId == orgId && organization.IsActive
            && user.IsActive && !user.IsDeleted && user.MustChangePassword
        select new BulkUser(user.Id, user.UserName, user.SecurityStamp);

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
