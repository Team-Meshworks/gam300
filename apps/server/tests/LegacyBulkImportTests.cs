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
public sealed class LegacyBulkImportTests
{
    private const string Initial = "Original synthetic 83! credential";
    private const string Replacement = "Different synthetic 72! credential";
    private const string LegacyPath = "/api/v1/admin/users/bulk";
    private static string Imports(Guid org) => $"/api/v1/admin/organizations/{org:D}/bulk-imports";
    private static ProvisionAccountRequest Row(Guid org, string name, string password = Initial) =>
        new() { OrgId = org, UserName = name, DisplayName = name, InitialPassword = password, Role = ApplicationRoles.Creator };

    [Test]
    public async Task LostLegacyReplyAndOperationIdAreRecoveredThroughFreshBrowserDiscovery()
    {
        var loss = new CommitProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(loss)));
        var (admin, org) = await SetupAsync(fixture);
        using var existing = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users", Row(org, "existing", Replacement));
        await Assert.That(existing.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var rows = new[] { Row(org, "existing", Replacement), Row(org, "new-learner"), Row(org, "NEW-LEARNER", Replacement) };
        loss.LoseReply = true;
        using var lost = await AuthTestRequests.PostAsync(fixture, LegacyPath, rows);
        await Assert.That((int)lost.StatusCode).IsGreaterThanOrEqualTo(500);
        await Assert.That(lost.Headers.Contains("X-Spatia-Operation-Id")).IsFalse();
        await using var fresh = await fixture.CreateSiblingAsync(_ => { });
        await fresh.SignInAsync(admin);
        using var listed = await fresh.Client.GetAsync(Imports(org));
        var list = await listed.Content.ReadFromJsonAsync<JsonElement>();
        var item = list.GetProperty("items").EnumerateArray().Single();
        var operation = item.GetProperty("operationId").GetGuid();
        await Assert.That(item.GetProperty("createdCount").GetInt32()).IsEqualTo(1);
        await Assert.That(list.GetRawText().Contains("new-learner", StringComparison.Ordinal)
            || list.GetRawText().Contains(Initial, StringComparison.Ordinal)).IsFalse();
        var path = Imports(org) + $"/{operation:D}";
        using var recovered = await AuthTestRequests.PostAsync(fresh, path + "/receipt", new { });
        await Assert.That(recovered.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var receipt = await recovered.Content.ReadFromJsonAsync<JsonElement>();
        var created = receipt.GetProperty("created").EnumerateArray().Single();
        await Assert.That(created.GetProperty("userName").GetString()).IsEqualTo("new-learner");
        await Assert.That(receipt.GetProperty("credentials").EnumerateArray().Single().GetProperty("password").GetString()).IsEqualTo(Initial);
        await Assert.That(receipt.GetRawText().Contains(Replacement, StringComparison.Ordinal)).IsFalse();
        using var replay = await AuthTestRequests.PutAsync(fresh.Client, path, rows, await fresh.GetCsrfAsync());
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await replay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("created")[0].GetProperty("userId").GetGuid())
            .IsEqualTo(created.GetProperty("userId").GetGuid());
        using var legacyRetry = await AuthTestRequests.PostAsync(fresh, LegacyPath, rows);
        await Assert.That(legacyRetry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await legacyRetry.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(0);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await db.Database.SqlQuery<string>($"""SELECT row_to_json(r)::text AS "Value" FROM bulk_import_receipts r WHERE organization_id = {org}""").SingleAsync();
        await Assert.That(stored.Contains(Initial, StringComparison.Ordinal) || stored.Contains(Replacement, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(Initial, StringComparison.Ordinal)).IsFalse();
        using var another = fresh.CreateClient();
        await fresh.SignInAsync(await fresh.CreateAccountAsync(ApplicationRoles.Administrator), another);
        using var hidden = await another.GetAsync(Imports(org));
        await Assert.That((await hidden.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0);
        using var forbiddenReceipt = await AuthTestRequests.PostAsync(fresh, path + "/receipt", new { }, another);
        await AuthTestRequests.AssertProblemAsync(forbiddenReceipt, HttpStatusCode.NotFound, "bulk_import_not_found");
    }

    [Test]
    public async Task LegacyResponseRetainsArrayShapeAndAllSkippedRetriesDoNotStoreReceipts()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        var rows = new[] { Row(org, "created"), Row(org, "CREATED", Replacement) };
        using var made = await AuthTestRequests.PostAsync(fixture, LegacyPath, rows);
        await Assert.That(made.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var response = await made.Content.ReadFromJsonAsync<JsonElement>();
        var account = response.EnumerateArray().Single();
        await Assert.That(account.EnumerateObject().Select(property => property.Name).ToArray())
            .IsEquivalentTo(new[] { "userId", "userName", "role", "orgId", "isActive", "mustChangePassword", "displayName" });
        await Assert.That(account.GetProperty("mustChangePassword").GetBoolean()).IsTrue();
        await Assert.That(response.GetRawText().Contains(Initial, StringComparison.Ordinal)).IsFalse();
        var operation = Guid.Parse(made.Headers.GetValues("X-Spatia-Operation-Id").Single());
        for (var index = 0; index < 3; index++)
        {
            using var empty = await AuthTestRequests.PostAsync(fixture, LegacyPath, rows);
            await Assert.That(empty.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await empty.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(0);
            await Assert.That(empty.Headers.Contains("X-Spatia-Operation-Id")).IsFalse();
        }
        using var listed = await fixture.Client.GetAsync(Imports(org) + "?limit=1");
        var list = await listed.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(list.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(list.GetProperty("items")[0].GetProperty("operationId").GetGuid()).IsEqualTo(operation);
        await Assert.That(list.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Database.SqlQuery<int>($"""SELECT count(*)::int AS "Value" FROM bulk_import_receipts WHERE organization_id = {org}""").SingleAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task LegacyUnavailableOrganizationKeepsAllSkippedCompatibilityAndRejectsNewRows(bool missing)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        using var existing = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users", Row(org, "existing"));
        await Assert.That(existing.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        if (missing) { org = Guid.NewGuid(); }
        else
        {
            await db.Organizations.Where(organization => organization.Id == org)
                .ExecuteUpdateAsync(update => update.SetProperty(organization => organization.IsActive, false));
        }
        using var skipped = await AuthTestRequests.PostAsync(fixture, LegacyPath, new[] { Row(org, "EXISTING") });
        await Assert.That(skipped.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await skipped.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(0);
        await Assert.That(skipped.Headers.Contains("X-Spatia-Operation-Id")).IsFalse();
        using var newRow = await AuthTestRequests.PostAsync(fixture, LegacyPath, new[] { Row(org, "new") });
        await AuthTestRequests.AssertProblemAsync(newRow, HttpStatusCode.UnprocessableEntity, "organization_unavailable");
        await Assert.That(await db.Users.AnyAsync(user => user.UserName == "new")).IsFalse();
        await Assert.That(await db.Database.SqlQuery<int>($"""SELECT count(*)::int AS "Value" FROM bulk_import_receipts WHERE organization_id = {org}""").SingleAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task InvalidLegacyBatchRollsBackReceiptAndCreatedRowsBeforeCorrectedRetry()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        using var invalid = await AuthTestRequests.PostAsync(fixture, LegacyPath, new[] { Row(org, "first"), Row(org, "invalid user?") });
        await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Users.AnyAsync(user => user.UserName == "first")).IsFalse();
        await Assert.That(await db.Database.SqlQuery<int>($"""SELECT count(*)::int AS "Value" FROM bulk_import_receipts WHERE organization_id = {org}""").SingleAsync()).IsEqualTo(0);
        using var corrected = await AuthTestRequests.PostAsync(fixture, LegacyPath, new[] { Row(org, "first"), Row(org, "second") });
        await Assert.That(corrected.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await Assert.That((await corrected.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength()).IsEqualTo(2);
    }

    [Test]
    public async Task LegacyAndKeyedConcurrentImportsShareNormalizedUsernameSerialization()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (_, org) = await SetupAsync(fixture);
        var token = await fixture.GetCsrfAsync();
        var results = await Task.WhenAll(
            AuthTestRequests.PostAsync(fixture, LegacyPath, new[] { Row(org, "race") }, token: token),
            AuthTestRequests.PutAsync(fixture.Client, Imports(org) + $"/{Guid.NewGuid():D}", new[] { Row(org, "RACE", Replacement) }, token));
        using var legacy = results[0];
        using var keyed = results[1];
        await Assert.That(legacy.IsSuccessStatusCode && keyed.IsSuccessStatusCode).IsTrue();
        var legacyCreated = (await legacy.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength();
        var keyedCreated = (await keyed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("created").GetArrayLength();
        await Assert.That(legacyCreated + keyedCreated).IsEqualTo(1);
        await Assert.That(legacy.StatusCode).IsEqualTo(legacyCreated == 1 ? HttpStatusCode.Created : HttpStatusCode.OK);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Users.CountAsync(user => user.NormalizedUserName == "RACE")).IsEqualTo(1);
    }

    [Test]
    public async Task LegacyExpiryAfterCommitStillAllowsOriginalActorDiscovery()
    {
        var expiry = new CommitProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(expiry)));
        var (admin, org) = await SetupAsync(fixture);
        var token = await fixture.GetCsrfAsync();
        expiry.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var response = await AuthTestRequests.PostAsync(fixture, LegacyPath, new[] { Row(org, "expired") }, token: token);
        await AuthTestRequests.AssertCommittedWithoutRepresentationAsync(response);
        await fixture.SignInAsync(admin);
        using var listed = await fixture.Client.GetAsync(Imports(org));
        await Assert.That((await listed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(1);
    }

    private static async Task<(Guid Admin, Guid Org)> SetupAsync(HttpsApplicationFixture fixture)
    {
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(admin);
        using var result = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/organizations", new { name = "Legacy bulk test" });
        result.EnsureSuccessStatusCode();
        return (admin, (await result.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
    }

    private sealed class CommitProbe : DbTransactionInterceptor
    {
        internal bool LoseReply;
        internal Action? After;
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            if (LoseReply) { LoseReply = false; throw new InvalidOperationException("Synthetic lost legacy bulk response"); }
            return Task.CompletedTask;
        }
    }
}
