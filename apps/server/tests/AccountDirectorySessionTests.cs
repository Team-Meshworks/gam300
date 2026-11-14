using System.Data.Common;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AccountDirectorySessionTests))]
public sealed class AccountDirectorySessionTests
{
    [Test]
    [Arguments("users", "list")]
    [Arguments("users", "detail")]
    [Arguments("users", "active")]
    [Arguments("organizations", "list")]
    [Arguments("organizations", "detail")]
    [Arguments("organizations", "active")]
    public async Task Directory_ExpiryAtCommitWithholdsReadDataAndAcknowledgesOnlyCommittedWrites(string resource, string operation)
    {
        var commit = new CommitProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit)));
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var target = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var id = resource == "users" ? target : await database.OrganizationMemberships
            .Where(row => row.UserId == target).Select(row => row.OrganizationId).SingleAsync();
        await fixture.SignInAsync(actor);
        var cutoff = new DateTimeOffset(long.Parse(
            fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!, CultureInfo.InvariantCulture), TimeSpan.Zero);
        var detailPath = $"/api/v1/admin/{resource}/{id:D}";
        var mutation = operation == "active";
        using var request = new HttpRequestMessage(mutation ? HttpMethod.Patch : HttpMethod.Get,
            operation == "list" ? $"/api/v1/admin/{resource}" : detailPath + (mutation ? "/active" : ""));
        if (mutation)
        {
            request.Content = JsonContent.Create(new { isActive = false });
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        }
        commit.After = () => fixture.Clock.Set(cutoff);
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(fixture.Clock.GetUtcNow()).IsEqualTo(cutoff);
        if (mutation) { await AuthTestRequests.AssertCommittedWithoutRepresentationAsync(response); }
        else { await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "authentication_required"); }
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
        var body = await response.Content.ReadAsStringAsync();
        await Assert.That(body.Contains(id.ToString("D"), StringComparison.Ordinal)).IsFalse();
        await Assert.That(body.Contains("\"items\"", StringComparison.Ordinal)).IsFalse();

        await fixture.SignInAsync(actor);
        using var reopened = await fixture.Client.GetAsync(detailPath);
        await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var record = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(record.GetProperty(resource == "users" ? "userId" : "id").GetGuid()).IsEqualTo(id);
        await Assert.That(record.GetProperty("isActive").GetBoolean()).IsEqualTo(!mutation);
    }

    [Test]
    [Arguments("organization")]
    [Arguments("asset")]
    [Arguments("keyedAsset")]
    public async Task CreateOrRemove_ExpiryAfterCommitRequiresAuthoritativeRecovery(string operation)
    {
        var commit = new CommitProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit)),
            environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var assetId = Guid.NewGuid();
        if (operation != "organization")
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var bytes = AssetIntakeTests.CreateMinimalGlb();
            db.AssetCandidates.Add(new AssetCandidate
            {
                Id = assetId,
                Name = "Synthetic retired room",
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
                SubmittedBy = actor,
                ReviewedBy = actor,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }
        await fixture.SignInAsync(actor);
        var cutoff = new DateTimeOffset(long.Parse(
            fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!, CultureInfo.InvariantCulture), TimeSpan.Zero);
        var token = await fixture.GetCsrfAsync();
        var operationId = Guid.NewGuid();
        var removalPath = $"/api/v1/admin/assets/{assetId:D}/removals/{operationId:D}";
        commit.After = () => fixture.Clock.Set(cutoff);
        using var response = operation switch
        {
            "organization" => await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/organizations", new { name = "Synthetic expiry school" }, token: token),
            "keyedAsset" => await AuthTestRequests.PutAsync(fixture.Client, removalPath, new { }, token),
            _ => await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{assetId:D}/availability", new AssetAvailabilityRequest("remove", true), token: token)
        };
        await AuthTestRequests.AssertCommittedWithoutRepresentationAsync(response);
        await Assert.That(response.Headers.Contains("X-Spatia-Operation-Id")).IsFalse();
        await fixture.SignInAsync(actor);
        if (operation == "keyedAsset")
        {
            using var check = await AuthTestRequests.PostAsync(fixture, removalPath + "/reconcile", new { });
            await Assert.That(check.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var receipt = await check.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(receipt.GetProperty("operationId").GetGuid()).IsEqualTo(operationId);
            await Assert.That(receipt.GetProperty("outcome").GetString()).IsEqualTo("removed");
        }
        using var recovered = await fixture.Client.GetAsync(operation == "organization" ? "/api/v1/admin/organizations" : "/api/v1/admin/assets");
        await Assert.That(recovered.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var result = await recovered.Content.ReadFromJsonAsync<JsonElement>();
        if (operation == "organization")
        {
            await Assert.That(result.GetProperty("items").EnumerateArray().Any(item => item.GetProperty("name").GetString() == "Synthetic expiry school")).IsTrue();
        }
        else
        {
            await Assert.That(result.GetProperty("assets").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == assetId).GetProperty("removedFromProjects").GetBoolean()).IsTrue();
        }
    }
    [Test]
    [Arguments(false, false)]
    [Arguments(false, true)]
    [Arguments(true, false)]
    [Arguments(true, true)]
    public async Task ProvisionAndReset_ExpiryRollsBackBeforeCommitAndWithholdsDetailsAfterCommit(bool reset, bool afterCommit)
    {
        var write = new WriteProbe();
        var commit = new CommitProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(write, commit)));
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var target = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(actor);
        var cutoff = new DateTimeOffset(long.Parse(
            fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!, CultureInfo.InvariantCulture), TimeSpan.Zero);
        var csrf = await fixture.GetCsrfAsync();
        void Expire() => fixture.Clock.Set(cutoff);
        if (afterCommit) { commit.After = Expire; } else { write.After = Expire; }
        using var response = reset
            ? await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/users/{target:D}/password",
                new { newTemporaryPassword = AuthTestRequests.NewPassword }, token: csrf)
            : await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users",
                new { userName = "expiry-test", initialPassword = AuthTestRequests.NewPassword, orgId = (Guid?)null, role = ApplicationRoles.Administrator }, token: csrf);
        if (afterCommit) { await AuthTestRequests.AssertCommittedWithoutRepresentationAsync(response); }
        else { await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "authentication_required"); }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        if (reset)
        {
            var manager = scope.ServiceProvider.GetRequiredService<Microsoft.AspNetCore.Identity.UserManager<ApplicationUser>>();
            var user = await database.Users.SingleAsync(row => row.Id == target);
            await Assert.That(await manager.CheckPasswordAsync(user, AuthTestRequests.NewPassword)).IsEqualTo(afterCommit);
        }
        else { await Assert.That(await database.Users.AnyAsync(row => row.UserName == "expiry-test")).IsEqualTo(afterCommit); }
    }

    private sealed class WriteProbe : SaveChangesInterceptor
    {
        public Action? After;

        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }

    private sealed class CommitProbe : DbTransactionInterceptor
    {
        public Action? After;

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return Task.CompletedTask;
        }
    }
}
