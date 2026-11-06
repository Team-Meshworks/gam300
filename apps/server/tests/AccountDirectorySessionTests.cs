using System.Data.Common;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountDirectorySessionTests
{
    [Test]
    [Arguments("users", "list")]
    [Arguments("users", "detail")]
    [Arguments("users", "active")]
    [Arguments("organizations", "list")]
    [Arguments("organizations", "detail")]
    [Arguments("organizations", "active")]
    public async Task Directory_ExpiryDuringCommitDeniesResponseAndPreservesCommittedState(string resource, string operation)
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
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "authentication_required");
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
