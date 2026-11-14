using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ReceiptMigrationRollbackTests))]
public sealed class ReceiptMigrationRollbackTests
{
    private const string BeforeBulk = "20261109085155_AddProjectImages";
    private const string Bulk = "20261114085737_AddBulkImportReceipts";
    private const string Removal = "20261114115659_AddAssetRemovalReceipts";

    [Test]
    [Arguments("bulk", false)]
    [Arguments("bulk", true)]
    [Arguments("asset", false)]
    [Arguments("asset", true)]
    public async Task PopulatedDowngradeRefusesAndPreservesCanceledOperationIncludingAnUncommittedWriter(string kind, bool concurrent)
    {
        var gate = new ReceiptCommitGate();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var (organization, asset) = await SeedAsync(fixture.Database, actor);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var operation = Guid.NewGuid();
        var path = kind == "bulk" ? $"/api/v1/admin/organizations/{organization:D}/bulk-imports/{operation:D}"
            : $"/api/v1/admin/assets/{asset:D}/removals/{operation:D}";
        gate.Armed = concurrent;
        var cancellation = AuthTestRequests.PostAsync(fixture, path + (kind == "bulk" ? "/abandon" : "/reconcile"), new { }, token: token);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await db.Database.OpenConnectionAsync();
        var migrationPid = ((NpgsqlConnection)db.Database.GetDbConnection()).ProcessID;
        Task? downgrade = null;
        try
        {
            if (concurrent)
            {
                await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
                downgrade = db.GetService<IMigrator>().MigrateAsync(kind == "bulk" ? BeforeBulk : Bulk);
                await WaitForBlockAsync(db.Database.GetConnectionString()!, migrationPid, gate.ProcessId);
            }
        }
        finally { gate.Release.TrySetResult(); }
        using var canceled = await cancellation;
        await Assert.That(canceled.StatusCode).IsEqualTo(kind == "bulk" ? HttpStatusCode.NoContent : HttpStatusCode.OK);
        downgrade ??= db.GetService<IMigrator>().MigrateAsync(kind == "bulk" ? BeforeBulk : Bulk);
        var refusal = await Assert.ThrowsAsync<PostgresException>(() => downgrade);
        await Assert.That(refusal!.SqlState).IsEqualTo(PostgresErrorCodes.RaiseException);
        await Assert.That((await db.Database.GetAppliedMigrationsAsync()).Contains(kind == "bulk" ? Bulk : Removal)).IsTrue();
        if (kind == "bulk")
        {
            await Assert.That(await db.Database.SqlQuery<int>($"""
                SELECT count(*)::int AS "Value" FROM bulk_import_receipts
                WHERE actor_id = {actor} AND organization_id = {organization} AND operation_id = {operation} AND protected_intent IS NULL
                """).SingleAsync()).IsEqualTo(1);
            using var delayed = await AuthTestRequests.PutAsync(fixture.Client, path,
                new[] { new ProvisionAccountRequest
                {
                    UserName = "delayed-downgrade", InitialPassword = "Synthetic delayed password1!", Role = ApplicationRoles.Creator,
                    OrgId = organization, DisplayName = "Delayed",
                } }, token);
            await AuthTestRequests.AssertProblemAsync(delayed, HttpStatusCode.Conflict, "bulk_import_abandoned");
            await Assert.That(await db.Users.AnyAsync(row => row.UserName == "delayed-downgrade")).IsFalse();
        }
        else
        {
            await Assert.That(await db.Database.SqlQuery<int>($"""
                SELECT count(*)::int AS "Value" FROM asset_removal_receipts
                WHERE actor_id = {actor} AND asset_id = {asset} AND operation_id = {operation} AND NOT applied
                """).SingleAsync()).IsEqualTo(1);
            using var delayed = await AuthTestRequests.PutAsync(fixture.Client, path, new { }, token);
            await AuthTestRequests.AssertProblemAsync(delayed, HttpStatusCode.Conflict, "asset_removal_conflict");
            using var receipt = await AuthTestRequests.PostAsync(fixture, path + "/reconcile", new { }, token: token);
            await Assert.That(receipt.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await receipt.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("outcome").GetString()).IsEqualTo("notApplied");
            await Assert.That(await db.AssetCandidates.Where(row => row.Id == asset).Select(row => row.RemovedFromProjects).SingleAsync()).IsFalse();
        }
    }

    [Test]
    [Arguments("bulk")]
    [Arguments("asset")]
    public async Task EmptyReceiptTablesCanDowngradeAndReapplyWithoutChangingExistingResources(string kind)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync(Removal);
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var actor = new ApplicationUser { Id = Guid.NewGuid(), UserName = "receipt-migration", NormalizedUserName = "RECEIPT-MIGRATION" };
        db.Users.Add(actor);
        await db.SaveChangesAsync();
        var (organization, asset) = await SeedAsync(fixture, actor.Id);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync(kind == "bulk" ? BeforeBulk : Bulk);
        var table = kind == "bulk" ? "bulk_import_receipts" : "asset_removal_receipts";
        await Assert.That(await db.Database.SqlQuery<bool>($"SELECT to_regclass({table}) IS NULL AS \"Value\"").SingleAsync()).IsTrue();
        await migrator.MigrateAsync(Removal);
        await Assert.That(await db.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM bulk_import_receipts").SingleAsync()).IsEqualTo(0);
        await Assert.That(await db.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM asset_removal_receipts").SingleAsync()).IsEqualTo(0);
        await Assert.That(await db.Users.AnyAsync(row => row.Id == actor.Id)).IsTrue();
        await Assert.That(await db.Organizations.AnyAsync(row => row.Id == organization)).IsTrue();
        await Assert.That(await db.AssetCandidates.Where(row => row.Id == asset).Select(row => row.RemovedFromProjects).SingleAsync()).IsFalse();
    }

    private static async Task<(Guid Organization, Guid Asset)> SeedAsync(PostgresAccountFixture fixture, Guid actor)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = new Organization { Id = Guid.NewGuid(), Name = "Receipt migration organization" };
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(), Name = "Receipt migration asset", Kind = "environment", Bytes = bytes,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), Status = "approved", Hidden = true, Deleted = true,
            Source = "Fixture", License = "Fixture", ReviewNotes = "Fixture", ValidationJson = "[]",
            SubmittedBy = actor, ReviewedBy = actor, CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Organizations.Add(organization);
        db.AssetCandidates.Add(asset);
        await db.SaveChangesAsync();
        return (organization.Id, asset.Id);
    }

    private static async Task WaitForBlockAsync(string connectionString, int waiter, int holder)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await using var query = new NpgsqlCommand("SELECT @holder = ANY(pg_blocking_pids(@waiter))", connection);
        query.Parameters.AddWithValue("holder", holder);
        query.Parameters.AddWithValue("waiter", waiter);
        while (!(bool)(await query.ExecuteScalarAsync(timeout.Token))!) { await Task.Delay(20, timeout.Token); }
    }

    private sealed class ReceiptCommitGate : DbTransactionInterceptor
    {
        public bool Armed;
        public int ProcessId;
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed)
            {
                Armed = false;
                ProcessId = ((NpgsqlConnection)transaction.Connection!).ProcessID;
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
            }
            return result;
        }
    }
}
