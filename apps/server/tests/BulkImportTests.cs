using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(BulkImportTests))]
public sealed class BulkImportTests
{
    private const string Initial = "Original synthetic 83! credential";
    private const string Replacement = "Different synthetic 72! credential";
    private static string Path(Guid org, Guid operation) => $"/api/v1/admin/organizations/{org:D}/bulk-imports/{operation:D}";
    private static ProvisionAccountRequest Row(Guid org, string name, string password = Initial) =>
        new() { OrgId = org, UserName = name, DisplayName = name, InitialPassword = password, Role = ApplicationRoles.Creator };

    [Test]
    public async Task LostReply_ReopenedAdminRecoversOnlyCommittedNewCredentialsAndCanAcknowledge()
    {
        var loss = new LoseCommit();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(loss)));
        var (admin, org) = await SetupAsync(fixture);
        var operation = Guid.NewGuid();
        var path = Path(org, operation);
        var rows = new[] { Row(org, "existing", Replacement), Row(org, "created"), Row(org, "CREATED", Replacement) };
        using var existing = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users", rows[0]);
        await Assert.That(existing.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var token = await fixture.GetCsrfAsync();
        loss.Armed = true;
        using var lost = await PutAsync(fixture.Client, path, rows, token);
        await Assert.That((int)lost.StatusCode).IsGreaterThanOrEqualTo(500);
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(admin);
        using var recovered = await AuthTestRequests.PostAsync(restarted, path + "/receipt", new { });
        await Assert.That(recovered.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(recovered.Headers.CacheControl?.NoStore).IsTrue();
        var receipt = await recovered.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(receipt.GetProperty("operationId").GetGuid()).IsEqualTo(operation);
        await Assert.That(receipt.GetProperty("orgId").GetGuid()).IsEqualTo(org);
        await Assert.That(receipt.GetProperty("created").GetArrayLength()).IsEqualTo(1);
        var created = receipt.GetProperty("created")[0];
        await Assert.That(created.GetProperty("userName").GetString()).IsEqualTo("created");
        var credential = receipt.GetProperty("credentials").EnumerateArray().Single();
        await Assert.That(credential.GetProperty("userId").GetGuid()).IsEqualTo(created.GetProperty("userId").GetGuid());
        await Assert.That(credential.GetProperty("password").GetString()).IsEqualTo(Initial);
        await Assert.That(receipt.GetRawText().Contains(Replacement, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(Initial, StringComparison.Ordinal)).IsFalse();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await db.Database.SqlQuery<string>($"""SELECT row_to_json(r)::text AS "Value" FROM bulk_import_receipts r WHERE operation_id = {operation}""").SingleAsync();
        await Assert.That(stored.Contains(Initial, StringComparison.Ordinal) || stored.Contains(Replacement, StringComparison.Ordinal)).IsFalse();
        using var replay = await PutAsync(restarted.Client, path, rows, await restarted.GetCsrfAsync());
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await replay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("created")[0].GetProperty("userId").GetGuid())
            .IsEqualTo(created.GetProperty("userId").GetGuid());
        using var changed = await PutAsync(restarted.Client, path, [rows[0], Row(org, "created", Replacement), rows[2]], await restarted.GetCsrfAsync());
        await AuthTestRequests.AssertProblemAsync(changed, HttpStatusCode.Conflict, "bulk_import_conflict");
        for (var i = 0; i < 2; i++)
        {
            using var acknowledged = await AuthTestRequests.PostAsync(restarted, path + "/acknowledge", new { });
            await Assert.That(acknowledged.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        using var closed = await AuthTestRequests.PostAsync(restarted, path + "/receipt", new { });
        var summary = await closed.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(summary.GetProperty("acknowledged").GetBoolean()).IsTrue();
        await Assert.That(summary.GetProperty("credentials").GetArrayLength()).IsEqualTo(0);
        await Assert.That(summary.GetProperty("created").GetArrayLength()).IsEqualTo(1);
        await Assert.That(await db.Database.SqlQuery<bool>($"""SELECT protected_handoff IS NULL AS "Value" FROM bulk_import_receipts WHERE operation_id = {operation}""").SingleAsync()).IsTrue();
    }

    [Test]
    public async Task Receipt_HandoffExpiringDuringCommitReturnsOnlyCreatedAccounts()
    {
        var probe = new LoseCommit();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)));
        var (admin, org) = await SetupAsync(fixture);
        var path = Path(org, Guid.NewGuid());
        using var created = await PutAsync(fixture.Client, path, [Row(org, "deadline")], await fixture.GetCsrfAsync());
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var deadline = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("expiresAt").GetDateTimeOffset();
        fixture.Clock.Set(deadline.AddMinutes(-1));
        await fixture.SignInAsync(admin);
        var token = await fixture.GetCsrfAsync();
        probe.After = () => fixture.Clock.Set(deadline);
        using var expiring = await AuthTestRequests.PostAsync(fixture, path + "/receipt", new { }, token: token);
        await Assert.That(expiring.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var result = await expiring.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(result.GetProperty("created").GetArrayLength()).IsEqualTo(1);
        await Assert.That(result.GetProperty("credentials").GetArrayLength()).IsEqualTo(0);
    }

    [Test]
    public async Task ConcurrentIdenticalImportsAndAbandonFenceProduceOneOutcome()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        var path = Path(org, Guid.NewGuid());
        var rows = new[] { Row(org, "concurrent") };
        var token = await fixture.GetCsrfAsync();
        var puts = await Task.WhenAll(PutAsync(fixture.Client, path, rows, token), PutAsync(fixture.Client, path, rows, token));
        using var first = puts[0];
        using var second = puts[1];
        await Assert.That(puts.Select(response => (int)response.StatusCode).Order().ToArray()).IsEquivalentTo(new[] { 200, 201 });
        var ids = new List<Guid>();
        foreach (var response in puts)
        {
            ids.Add((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("created").EnumerateArray().Single().GetProperty("userId").GetGuid());
        }
        await Assert.That(ids.Distinct().Count()).IsEqualTo(1);
        using var committed = await AuthTestRequests.PostAsync(fixture, path + "/abandon", new { });
        await AuthTestRequests.AssertProblemAsync(committed, HttpStatusCode.Conflict, "bulk_import_committed");
        var absent = Path(org, Guid.NewGuid());
        using var missing = await AuthTestRequests.PostAsync(fixture, absent + "/receipt", new { });
        await AuthTestRequests.AssertProblemAsync(missing, HttpStatusCode.NotFound, "bulk_import_not_found");
        using var abandoned = await AuthTestRequests.PostAsync(fixture, absent + "/abandon", new { });
        await Assert.That(abandoned.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var delayed = await PutAsync(fixture.Client, absent, [Row(org, "late")], token);
        await AuthTestRequests.AssertProblemAsync(delayed, HttpStatusCode.Conflict, "bulk_import_abandoned");
        using var canceled = await AuthTestRequests.PostAsync(fixture, absent + "/receipt", new { });
        await AuthTestRequests.AssertProblemAsync(canceled, HttpStatusCode.Conflict, "bulk_import_abandoned");
        var skippedPath = Path(org, Guid.NewGuid());
        using var skipped = await PutAsync(fixture.Client, skippedPath, rows, token);
        await Assert.That(skipped.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var empty = await skipped.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(empty.GetProperty("created").GetArrayLength()).IsEqualTo(0);
        await Assert.That(empty.GetProperty("credentials").GetArrayLength()).IsEqualTo(0);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Users.AnyAsync(row => row.UserName == "late")).IsFalse();
        await Assert.That(await db.Users.CountAsync(row => row.UserName == "concurrent")).IsEqualTo(1);
    }

    [Test]
    public async Task Handoff_RequiresOriginalCurrentAdministratorAndUnchangedTemporaryAccountCredentials()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (admin, org) = await SetupAsync(fixture);
        var op = Guid.NewGuid();
        var path = Path(org, op);
        var rows = new[] { Row(org, "rotate"), Row(org, "firstchange"), Row(org, "keep") };
        using var made = await PutAsync(fixture.Client, path, rows, await fixture.GetCsrfAsync());
        await Assert.That(made.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var created = (await made.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("created").EnumerateArray().ToDictionary(
            row => row.GetProperty("userName").GetString()!, row => row.GetProperty("userId").GetGuid());
        using var student = fixture.CreateClient();
        await fixture.SignInAsync(created["firstchange"], student);
        using var changed = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/password", new { currentPassword = Initial, newPassword = Replacement }, student);
        await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var reset = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/users/{created["rotate"]:D}/password", new { newTemporaryPassword = Replacement });
        await Assert.That(reset.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var visible = await AuthTestRequests.PostAsync(fixture, path + "/receipt", new { });
        var receipt = await visible.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(receipt.GetProperty("created").GetArrayLength()).IsEqualTo(3);
        await Assert.That(receipt.GetProperty("credentials").EnumerateArray().Single().GetProperty("userName").GetString()).IsEqualTo("keep");
        using var wrongOrg = await AuthTestRequests.PostAsync(fixture, Path(Guid.NewGuid(), op) + "/receipt", new { });
        await AuthTestRequests.AssertProblemAsync(wrongOrg, HttpStatusCode.NotFound, "bulk_import_not_found");
        using var different = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator), different);
        using var denied = await AuthTestRequests.PostAsync(fixture, path + "/receipt", new { }, different);
        await AuthTestRequests.AssertProblemAsync(denied, HttpStatusCode.NotFound, "bulk_import_not_found");
        using var noCsrf = await fixture.Client.PostAsJsonAsync(path + "/receipt", new { });
        await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var unprivileged = await AuthTestRequests.PostAsync(fixture, path + "/receipt", new { }, student);
        await Assert.That(unprivileged.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        var cutoff = receipt.GetProperty("expiresAt").GetDateTimeOffset();
        fixture.Clock.Set(cutoff);
        await fixture.SignInAsync(admin);
        using var expired = await AuthTestRequests.PostAsync(fixture, path + "/receipt", new { });
        var summary = await expired.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(summary.GetProperty("created").GetArrayLength()).IsEqualTo(3);
        await Assert.That(summary.GetProperty("credentials").GetArrayLength()).IsEqualTo(0);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Database.SqlQuery<bool>($"""SELECT protected_handoff IS NULL AS "Value" FROM bulk_import_receipts WHERE operation_id = {op}""").SingleAsync()).IsTrue();
    }

    [Test]
    public async Task BulkImport_AcceptsTheDocumentedTwoHundredRowsAndRejectsLargerBatches()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        var rows = Enumerable.Range(0, 200).Select(i => Row(org, $"learner{i:D3}")).ToArray();
        var token = await fixture.GetCsrfAsync();
        using var uploader = fixture.CreateClient(fixture.Cookies);
        uploader.Timeout = TimeSpan.FromMinutes(2);
        using var response = await PutAsync(uploader, Path(org, Guid.NewGuid()), rows, token);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var receipt = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(receipt.GetProperty("created").GetArrayLength()).IsEqualTo(rows.Length);
        await Assert.That(receipt.GetProperty("credentials").GetArrayLength()).IsEqualTo(rows.Length);
        using var rejected = await PutAsync(fixture.Client, Path(org, Guid.NewGuid()), [.. rows, Row(org, "one-too-many")], token);
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Users.AnyAsync(row => row.UserName == "one-too-many")).IsFalse();
    }

    [Test]
    public async Task BulkImport_ConcurrentAbandonAndPutCannotBothWinAndHardDeletionRemovesReceipt()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        var token = await fixture.GetCsrfAsync();
        var path = Path(org, Guid.NewGuid());
        var attempts = await Task.WhenAll(PutAsync(fixture.Client, path, [Row(org, "race")], token),
            AuthTestRequests.PostAsync(fixture, path + "/abandon", new { }, token: token));
        using var put = attempts[0];
        using var abandon = attempts[1];
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        if (put.StatusCode == HttpStatusCode.Created)
        {
            await AuthTestRequests.AssertProblemAsync(abandon, HttpStatusCode.Conflict, "bulk_import_committed");
            await Assert.That(await db.Users.AnyAsync(row => row.UserName == "race")).IsTrue();
        }
        else
        {
            await AuthTestRequests.AssertProblemAsync(put, HttpStatusCode.Conflict, "bulk_import_abandoned");
            await Assert.That(abandon.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await Assert.That(await db.Users.AnyAsync(row => row.UserName == "race")).IsFalse();
        }
        var otherPath = Path(org, Guid.NewGuid());
        using var confirmed = await PutAsync(fixture.Client, otherPath, [Row(org, "confirmed")], token);
        await Assert.That(confirmed.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/admin/organizations/{org:D}")
        { Content = JsonContent.Create(new { confirmationName = "Bulk test" }) };
        delete.Headers.Add("X-CSRF-TOKEN", token);
        using var removed = await fixture.Client.SendAsync(delete);
        await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var gone = await AuthTestRequests.PostAsync(fixture, otherPath + "/receipt", new { });
        await AuthTestRequests.AssertProblemAsync(gone, HttpStatusCode.NotFound, "bulk_import_not_found");
        await Assert.That(await db.Database.SqlQuery<int>($"""SELECT count(*)::int AS "Value" FROM bulk_import_receipts WHERE organization_id = {org}""").SingleAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task BulkImport_InvalidBatchRollsBackUsersAndReceiptThenCorrectedRetryCommits()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        var path = Path(org, Guid.NewGuid());
        var token = await fixture.GetCsrfAsync();
        using var invalid = await PutAsync(fixture.Client, path, [Row(org, "first"), Row(org, "invalid user?")], token);
        await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var missing = await AuthTestRequests.PostAsync(fixture, path + "/receipt", new { });
        await AuthTestRequests.AssertProblemAsync(missing, HttpStatusCode.NotFound, "bulk_import_not_found");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Users.AnyAsync(row => row.UserName == "first")).IsFalse();
        using var corrected = await PutAsync(fixture.Client, path, [Row(org, "first"), Row(org, "second")], token);
        await Assert.That(corrected.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await Assert.That((await corrected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("created").GetArrayLength()).IsEqualTo(2);
    }

    [Test]
    public async Task Discovery_FreshAdminSessionCanPageOnlyOwnOutstandingReceiptsWithoutAccountOrCredentialData()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (admin, org) = await SetupAsync(fixture);
        var token = await fixture.GetCsrfAsync();
        var ids = new List<Guid>();
        var rows = new[] { Row(org, "only-created-name") };
        for (var i = 0; i < 3; i++)
        {
            var id = Guid.NewGuid();
            ids.Add(id);
            using var opened = await PutAsync(fixture.Client, Path(org, id), rows, token);
            await Assert.That(opened.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
        using var abandoned = await AuthTestRequests.PostAsync(fixture, Path(org, Guid.NewGuid()) + "/abandon", new { });
        await Assert.That(abandoned.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await using var fresh = await fixture.CreateSiblingAsync(_ => { });
        await fresh.SignInAsync(admin);
        var list = $"/api/v1/admin/organizations/{org:D}/bulk-imports";
        var seen = new List<Guid>();
        string? cursor = null;
        for (var page = 0; page < ids.Count; page++)
        {
            using var result = await fresh.Client.GetAsync(list + "?limit=1" + (cursor is null ? "" : "&cursor=" + cursor));
            await Assert.That(result.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(result.Headers.CacheControl?.NoStore).IsTrue();
            var data = await result.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(data.GetRawText().Contains(rows[0].UserName, StringComparison.Ordinal)).IsFalse();
            var item = data.GetProperty("items").EnumerateArray().Single();
            await Assert.That(item.EnumerateObject().Select(field => field.Name).Order().ToArray())
                .IsEquivalentTo(new[] { "createdAt", "createdCount", "expiresAt", "operationId" });
            var id = item.GetProperty("operationId").GetGuid();
            seen.Add(id);
            await Assert.That(item.GetProperty("createdCount").GetInt32()).IsEqualTo(id == ids[0] ? 1 : 0);
            await Assert.That(item.GetProperty("expiresAt").GetDateTimeOffset() - item.GetProperty("createdAt").GetDateTimeOffset()).IsEqualTo(TimeSpan.FromHours(24));
            cursor = data.GetProperty("nextCursor").GetString();
            await Assert.That(cursor is null).IsEqualTo(page == ids.Count - 1);
        }
        await Assert.That(seen.SequenceEqual(ids.Order())).IsTrue();
        using var acknowledged = await AuthTestRequests.PostAsync(fresh, Path(org, ids[1]) + "/acknowledge", new { });
        await Assert.That(acknowledged.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var remaining = await fresh.Client.GetAsync(list);
        await Assert.That((await remaining.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(2);
        using var other = fresh.CreateClient();
        await fresh.SignInAsync(await fresh.CreateAccountAsync(ApplicationRoles.Administrator), other);
        using var different = await other.GetAsync(list);
        await Assert.That((await different.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0);
        using var normal = fresh.CreateClient();
        await fresh.SignInAsync(await fresh.CreateAccountAsync(), normal);
        using var forbidden = await normal.GetAsync(list);
        await Assert.That(forbidden.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var missingOrg = await fresh.Client.GetAsync($"/api/v1/admin/organizations/{Guid.NewGuid():D}/bulk-imports");
        await AuthTestRequests.AssertProblemAsync(missingOrg, HttpStatusCode.NotFound, "bulk_import_not_found");
        fixture.Clock.Advance(TimeSpan.FromHours(24));
        await fresh.SignInAsync(admin);
        using var expired = await fresh.Client.GetAsync(list);
        await Assert.That((await expired.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0);
    }

    private static async Task<(Guid Admin, Guid Org)> SetupAsync(HttpsApplicationFixture fixture)
    {
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        using var result = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/organizations", new { name = "Bulk test" });
        result.EnsureSuccessStatusCode();
        return (admin, (await result.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
    }

    private static async Task<HttpResponseMessage> PutAsync(HttpClient client, string path, ProvisionAccountRequest[] rows, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, path) { Content = JsonContent.Create(rows) };
        request.Headers.Add("X-CSRF-TOKEN", token);
        return await client.SendAsync(request);
    }

    private sealed class LoseCommit : DbTransactionInterceptor
    {
        public bool Armed;
        public Action? After;
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            if (Armed) { Armed = false; throw new InvalidOperationException("Synthetic lost bulk response"); }
            return Task.CompletedTask;
        }
    }
}
