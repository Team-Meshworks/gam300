using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(AssetIntakeTests))]
public sealed class AssetAuthorityTests
{
    [Test]
    [Arguments(false, false)]
    [Arguments(false, true)]
    [Arguments(true, false)]
    [Arguments(true, true)]
    public async Task InvalidatedCredentialsCannotReadCatalogueOrBytesAfterDatabaseWait(bool administrator, bool expire)
    {
        foreach (var bytes in new[] { false, true })
        {
            var pause = new AssetCommandPause();
            await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
                builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause)),
                environmentName: "Development");
            var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
            var assetId = await SeedAsync(fixture, actor, "approved");
            await fixture.SignInAsync(actor);
            pause.Match = "FROM asset_candidates";
            var path = administrator ? "/api/v1/admin/assets" : "/api/v1/assets";
            if (bytes) { path += $"/{assetId:D}/bytes"; }
            var reading = fixture.Client.GetAsync(path);
            try
            {
                await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
                if (expire) { fixture.Clock.Advance(TimeSpan.FromHours(9)); }
                else
                {
                    await using var revoke = fixture.Database.Services.CreateAsyncScope();
                    await revoke.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(user => user.Id == actor)
                        .ExecuteUpdateAsync(update => update.SetProperty(user => user.SecurityStamp, Guid.NewGuid().ToString()));
                }
            }
            finally { pause.Release.TrySetResult(); }
            using var denied = await reading;
            await AuthTestRequests.AssertProblemAsync(denied, HttpStatusCode.Unauthorized, "authentication_required");
            await Assert.That((await denied.Content.ReadAsStringAsync()).Contains("Private source", StringComparison.Ordinal)).IsFalse();
        }
    }

    [Test]
    [Arguments("upload", false)]
    [Arguments("approve", false)]
    [Arguments("hide", false)]
    [Arguments("upload", true)]
    [Arguments("approve", true)]
    [Arguments("hide", true)]
    public async Task CredentialInvalidationDuringWriteWaitRollsBackAndConcealsAsset(string action, bool expire)
    {
        var pause = new AssetCommandPause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause)),
            environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var assetId = await SeedAsync(fixture, actor, action == "approve" ? "pending" : "approved");
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, action == "upload"
            ? "/api/v1/admin/assets?name=New.glb&kind=model&category=Objects"
            : $"/api/v1/admin/assets/{assetId:D}/" + (action == "approve" ? "approve" : "availability"));
        request.Headers.Add("X-CSRF-TOKEN", token);
        if (action == "upload")
        {
            request.Content = new ByteArrayContent(AssetIntakeTests.CreateMinimalGlb());
            request.Content.Headers.ContentType = new("model/gltf-binary");
        }
        else
        {
            request.Content = action == "approve" ? JsonContent.Create(new AssetReviewRequest("Private source", "License", "Review"))
                : JsonContent.Create(new AssetAvailabilityRequest(action));
        }
        pause.Match = action == "upload" ? "pg_advisory_xact_lock(167168)" : "UPDATE asset_candidates";
        var writing = fixture.Client.SendAsync(request);
        try
        {
            await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            if (expire) { fixture.Clock.Advance(TimeSpan.FromHours(9)); }
            else
            {
                await using var revoke = fixture.Database.Services.CreateAsyncScope();
                await revoke.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(user => user.Id == actor)
                    .ExecuteUpdateAsync(update => update.SetProperty(user => user.SecurityStamp, Guid.NewGuid().ToString()));
            }
        }
        finally { pause.Release.TrySetResult(); }
        using var denied = await writing;
        await AuthTestRequests.AssertProblemAsync(denied, HttpStatusCode.Unauthorized, "authentication_required");
        await Assert.That((await denied.Content.ReadAsStringAsync()).Contains("Private source", StringComparison.Ordinal)).IsFalse();
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        var database = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var asset = await database.AssetCandidates.SingleAsync();
        await Assert.That(asset.Status).IsEqualTo(action == "approve" ? "pending" : "approved");
        await Assert.That(asset.Hidden).IsFalse();
    }

    [Test]
    [Arguments("upload")]
    [Arguments("approve")]
    [Arguments("hide")]
    [Arguments("remove")]
    [Arguments("keyed-remove")]
    public async Task ExpiryAfterCommitConfirmsWriteWithoutProtectedRepresentation(string action)
    {
        var expiry = new CommitExpiry();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(expiry)),
            environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var assetId = await SeedAsync(fixture, actor, action == "approve" ? "pending" : "approved", action.Contains("remove", StringComparison.Ordinal));
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var path = action == "upload" ? "/api/v1/admin/assets?name=New.glb&kind=model&category=Objects"
            : $"/api/v1/admin/assets/{assetId:D}/" + (action == "approve" ? "approve"
                : action == "keyed-remove" ? $"removals/{Guid.NewGuid():D}" : "availability");
        using var request = new HttpRequestMessage(action == "keyed-remove" ? HttpMethod.Put : HttpMethod.Post, path);
        request.Headers.Add("X-CSRF-TOKEN", token);
        if (action == "keyed-remove") { request.Headers.Add("Prefer", "spatia-created-status"); }
        request.Content = action == "upload" ? new ByteArrayContent(AssetIntakeTests.CreateMinimalGlb())
            : action == "approve" ? JsonContent.Create(new AssetReviewRequest("Private source", "License", "Review"))
            : action == "keyed-remove" ? JsonContent.Create(new { }) : JsonContent.Create(new AssetAvailabilityRequest(action));
        if (action == "upload") { request.Content.Headers.ContentType = new("model/gltf-binary"); }
        expiry.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var response = await fixture.Client.SendAsync(request);
        await AuthTestRequests.AssertCommittedWithoutRepresentationAsync(response);
        await Assert.That(response.Headers.Contains("Preference-Applied")).IsFalse();
        await Assert.That(response.Headers.Contains("X-Spatia-Operation-Id")).IsFalse();
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        var database = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        if (action == "upload") { await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(2); }
        else
        {
            var asset = await database.AssetCandidates.SingleAsync();
            await Assert.That(asset.Status).IsEqualTo("approved");
            await Assert.That(asset.Hidden).IsEqualTo(action != "approve");
            await Assert.That(asset.RemovedFromProjects).IsEqualTo(action.Contains("remove", StringComparison.Ordinal));
        }
    }

    [Test]
    public async Task ExpiryBeforeRemovalCommitCannotAdvertiseNegotiatedSuccess()
    {
        var expiry = new SaveExpiry();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(expiry)),
            environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedAsync(fixture, actor, "approved", deleted: true);
        await fixture.SignInAsync(actor);
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/admin/assets/{asset:D}/removals/{Guid.NewGuid():D}");
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        request.Headers.Add("Prefer", "spatia-created-status");
        request.Content = JsonContent.Create(new { });
        expiry.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var response = await fixture.Client.SendAsync(request);
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.Unauthorized, "authentication_required");
        await Assert.That(response.Headers.Contains("Preference-Applied")).IsFalse();
        await Assert.That(response.Headers.Contains("X-Spatia-Operation-Id")).IsFalse();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.AssetCandidates.Select(row => row.RemovedFromProjects).SingleAsync()).IsFalse();
        await Assert.That(await db.Set<AssetRemovalReceipt>().AnyAsync()).IsFalse();
    }

    private static async Task<Guid> SeedAsync(HttpsApplicationFixture fixture, Guid actor, string status, bool deleted = false)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = "Private source",
            Kind = "model",
            Category = "Objects",
            Status = status,
            Bytes = [1, 2, 3],
            Sha256 = new string('a', 64),
            ValidationJson = "[]",
            SubmittedBy = actor,
            ReviewedBy = status == "approved" ? actor : null,
            Source = "Private source",
            License = "License",
            ReviewNotes = "Review",
            Hidden = deleted,
            Deleted = deleted,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        database.AssetCandidates.Add(asset);
        await database.SaveChangesAsync();
        return asset.Id;
    }

    private sealed class AssetCommandPause : DbCommandInterceptor
    {
        internal string? Match;
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private async Task PauseAsync(DbCommand command, CancellationToken token)
        {
            if (Match is { } match && command.CommandText.Contains(match, StringComparison.Ordinal))
            {
                Match = null;
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(20), token);
            }
        }

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            await PauseAsync(command, cancellationToken);
            return result;
        }

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            await PauseAsync(command, cancellationToken);
            return result;
        }
    }

    private sealed class CommitExpiry : DbTransactionInterceptor
    {
        internal Action? After;
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return Task.CompletedTask;
        }
    }

    private sealed class SaveExpiry : SaveChangesInterceptor
    {
        internal Action? After;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }
}
