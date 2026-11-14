using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class AssetRemovalBrowserTests
{
    [Test]
    public async Task DisconnectedRemoval_CannotBeReplacedBeforeItsReceiptIsResolved()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var assetId = Guid.NewGuid();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        database.AssetCandidates.Add(new AssetCandidate
        {
            Id = assetId,
            Name = "Receipt race room",
            Kind = "environment",
            Bytes = bytes,
            Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
            Status = "approved",
            Hidden = true,
            Deleted = true,
            Source = "Fixture",
            License = "Fixture",
            ReviewNotes = "Fixture",
            ValidationJson = "[]",
            SubmittedBy = administrator,
            ReviewedBy = administrator,
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await database.SaveChangesAsync();
        await using var transaction = await database.Database.BeginTransactionAsync();
        await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM asset_candidates WHERE id = {assetId} FOR UPDATE").SingleAsync();
        var blockerPid = await database.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync();
        var files = fixture.WritePemFiles();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "apps", "web", "vite.config.ts"))) { root = root.Parent; }
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root!.FullName, "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/asset-removal-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_ADMIN"] = await AuthTestRequests.UserNameAsync(fixture, administrator);
        start.Environment["SPATIA_TEST_ASSET"] = assetId.ToString("D");
        start.Environment["SPATIA_TEST_SYNC"] = fixture.KeyDirectory;
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            while (!File.Exists(Path.Combine(fixture.KeyDirectory, "forwarded")) && !process.HasExited)
            { await Task.Delay(50, timeout.Token); }
            await using var probeScope = fixture.Database.Services.CreateAsyncScope();
            var probe = probeScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            while (!process.HasExited && !await probe.Database.SqlQuery<bool>($"""
                SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                  AND {blockerPid} = ANY(pg_blocking_pids(pid))) AS "Value"
                """).SingleAsync(timeout.Token))
            { await Task.Delay(50, timeout.Token); }
            await File.WriteAllTextAsync(Path.Combine(fixture.KeyDirectory, "blocked"), "ready", timeout.Token);
            while (!File.Exists(Path.Combine(fixture.KeyDirectory, "release")) && !process.HasExited)
            { await Task.Delay(50, timeout.Token); }
            await transaction.CommitAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
        }
        catch { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        await database.Entry(database.AssetCandidates.Local.Single(row => row.Id == assetId)).ReloadAsync();
        await Assert.That(database.AssetCandidates.Local.Single(row => row.Id == assetId).RemovedFromProjects).IsTrue();
        var operationId = Guid.Parse(await File.ReadAllTextAsync(Path.Combine(fixture.KeyDirectory, "operation")));
        var receipts = await database.Database.SqlQuery<int>($"""
            SELECT count(*)::int AS "Value" FROM asset_removal_receipts
            WHERE actor_id = {administrator} AND operation_id = {operationId} AND asset_id = {assetId} AND applied
            """).SingleAsync();
        await Assert.That(receipts).IsEqualTo(1);
        var allReceipts = await database.Database.SqlQuery<int>($"""
            SELECT count(*)::int AS "Value" FROM asset_removal_receipts WHERE asset_id = {assetId}
            """).SingleAsync();
        await Assert.That(allReceipts).IsEqualTo(1);
    }
}
