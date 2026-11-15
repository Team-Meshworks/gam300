using System.Data.Common;
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

[NotInParallel(nameof(AssetIntakeTests))]
public sealed class AssetRemovalReceiptTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task HistoricalReceiptBindingsTakePrecedenceOverLaterAssetKeyReservations(bool applied)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        var operation = await SeedRetiredAsync(fixture, actor);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        if (applied)
        {
            await db.AssetCandidates.Where(row => row.Id == asset)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.RemovedFromProjects, true));
        }

        db.Set<AssetRemovalReceipt>().Add(new AssetRemovalReceipt
        {
            ActorId = actor,
            AssetId = asset,
            OperationId = operation,
            Applied = applied,
        });
        await db.SaveChangesAsync();
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var path = Path(asset, operation);
        using var replay = await AuthTestRequests.PutAsync(fixture.Client, path, new
        {
        }, token);

        await Assert.That(replay.StatusCode).IsEqualTo(applied ? HttpStatusCode.OK : HttpStatusCode.Conflict);

        if (applied)
        {
            var record = (await replay.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;

            await Assert.That(record.Id).IsEqualTo(asset);
            await Assert.That(record.RemovedFromProjects).IsTrue();
        }

        using var receipt = await AuthTestRequests.PostAsync(fixture, path + "/reconcile", new
        {
        }, token: token);
        await AssertReceiptAsync(receipt, asset, operation, applied ? "removed" : "notApplied");
        using var mismatchedReplay = await AuthTestRequests.PutAsync(fixture.Client, Path(operation, operation), new
        {
        }, token);
        await AuthTestRequests.AssertProblemAsync(mismatchedReplay, HttpStatusCode.Conflict, "asset_removal_conflict");
        using var mismatchedReceipt = await AuthTestRequests.PostAsync(fixture, Path(operation, operation) + "/reconcile", new
        {
        }, token: token);
        await AuthTestRequests.AssertProblemAsync(mismatchedReceipt, HttpStatusCode.Conflict, "asset_removal_conflict");

        await Assert.That(await db.AssetCandidates.Where(row => row.Id == asset).Select(row => row.RemovedFromProjects).SingleAsync()).IsEqualTo(applied);
    }

    [Test]
    public async Task NewOperationBindingsCannotUseAnotherAssetsReservedIdentity()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        var reserved = await SeedRetiredAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var path = Path(asset, reserved);
        using var removal = await AuthTestRequests.PutAsync(fixture.Client, path, new
        {
        }, token);
        await AuthTestRequests.AssertProblemAsync(removal, HttpStatusCode.Conflict, "asset_removal_conflict");
        using var reconciliation = await AuthTestRequests.PostAsync(fixture, path + "/reconcile", new
        {
        }, token: token);
        await AuthTestRequests.AssertProblemAsync(reconciliation, HttpStatusCode.Conflict, "asset_removal_conflict");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        await Assert.That(await db.Set<AssetRemovalReceipt>().AnyAsync()).IsFalse();
        await Assert.That(await db.AssetCandidates.AnyAsync(row => row.RemovedFromProjects)).IsFalse();
    }

    [Test]
    public async Task LegacyRemovalHasRecoverableAssetIdentityWithoutChangingRepeatConflict()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        using var legacy = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{asset:D}/availability",
            new AssetAvailabilityRequest("remove", true), token: token);

        await Assert.That(legacy.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(legacy.Headers.GetValues("X-Spatia-Operation-Id").Single()).IsEqualTo(asset.ToString("D"));

        using var receipt = await AuthTestRequests.PostAsync(fixture, Path(asset, asset) + "/reconcile", new
        {
        }, token: token);
        await AssertReceiptAsync(receipt, asset, asset, "removed");
        using var repeated = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{asset:D}/availability",
            new AssetAvailabilityRequest("remove"), token: token);

        await Assert.That(repeated.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
    }

    [Test]
    public async Task LegacyAbsenceFenceRequiresANewKeyAndHistoricalRemovalCannotInventActorProof()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        using var absent = await AuthTestRequests.PostAsync(fixture, Path(asset, asset) + "/reconcile", new
        {
        }, token: token);
        await AssertReceiptAsync(absent, asset, asset, "notApplied");
        using var legacy = await AuthTestRequests.PostAsync(fixture, $"/api/v1/admin/assets/{asset:D}/availability",
            new AssetAvailabilityRequest("remove"), token: token);

        await Assert.That(legacy.StatusCode).IsEqualTo(HttpStatusCode.Conflict);

        using var explicitKey = await AuthTestRequests.PutAsync(fixture.Client, Path(asset, Guid.NewGuid()), new
        {
        }, token);

        await Assert.That(explicitKey.StatusCode).IsEqualTo(HttpStatusCode.OK);

        using var otherActor = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator), otherActor);
        using var historical = await AuthTestRequests.PostAsync(fixture, Path(asset, asset) + "/reconcile", new
        {
        }, otherActor);
        await AuthTestRequests.AssertProblemAsync(historical, HttpStatusCode.Conflict, "asset_removal_history_unavailable");
    }

    [Test]
    public async Task CreatedStatusIsNegotiatedAndReplaysRemainOk()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var path = Path(asset, Guid.NewGuid());

        foreach (var expected in new[] { HttpStatusCode.Created, HttpStatusCode.OK })
        {
            using var request = new HttpRequestMessage(HttpMethod.Put, path);
            request.Headers.Add("X-CSRF-TOKEN", token);
            request.Headers.Add("Prefer", "spatia-created-status");
            request.Content = JsonContent.Create(new
            {
            });
            using var response = await fixture.Client.SendAsync(request);

            await Assert.That(response.StatusCode).IsEqualTo(expected);
            await Assert.That(response.Headers.GetValues("Preference-Applied").Single()).IsEqualTo("spatia-created-status");
        }
    }

    [Test]
    public async Task ReopenedIssuerCanReplayAndReconcileOnlyTheOriginalRemoval()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        var otherAsset = await SeedRetiredAsync(fixture, actor);
        var operation = Guid.NewGuid();
        var path = Path(asset, operation);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var first = AuthTestRequests.PutAsync(fixture.Client, path, new
        {
        }, token);
        var second = AuthTestRequests.PutAsync(fixture.Client, path, new
        {
        }, token);
        using var removed = await first;
        using var simultaneous = await second;

        foreach (var result in new[] { removed, simultaneous })
        {
            await Assert.That(result.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(result.Headers.GetValues("X-Spatia-Operation-Id").Single()).IsEqualTo(operation.ToString("D"));

            var candidate = (await result.Content.ReadFromJsonAsync<AssetAdministrationRecord>())!;

            await Assert.That(candidate.Id).IsEqualTo(asset);
            await Assert.That(candidate.RemovedFromProjects).IsTrue();
        }

        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);
        using var recovered = await AuthTestRequests.PostAsync(reopened, path + "/reconcile", new
        {
        });
        await AssertReceiptAsync(recovered, asset, operation, "removed");
        using var replay = await AuthTestRequests.PutAsync(reopened.Client, path, new
        {
        }, await reopened.GetCsrfAsync());

        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);

        using var mismatch = await AuthTestRequests.PutAsync(reopened.Client, Path(otherAsset, operation), new
        {
        }, await reopened.GetCsrfAsync());

        await Assert.That(mismatch.StatusCode).IsEqualTo(HttpStatusCode.Conflict);

        using var mismatchedRead = await AuthTestRequests.PostAsync(reopened, Path(otherAsset, operation) + "/reconcile", new
        {
        });

        await Assert.That(mismatchedRead.StatusCode).IsEqualTo(HttpStatusCode.Conflict);

        using var other = reopened.CreateClient();
        await reopened.SignInAsync(await reopened.CreateAccountAsync(ApplicationRoles.Administrator), other);
        using var independent = await AuthTestRequests.PostAsync(reopened, path + "/reconcile", new
        {
        }, other);
        await AssertReceiptAsync(independent, asset, operation, "notApplied");
        using var creator = reopened.CreateClient();
        await reopened.SignInAsync(await reopened.CreateAccountAsync(), creator);
        using var denied = await AuthTestRequests.PostAsync(reopened, path + "/reconcile", new
        {
        }, creator);

        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);

        await using var scope = reopened.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        await Assert.That(await db.AssetCandidates.Where(row => row.Id == otherAsset).Select(row => row.RemovedFromProjects).SingleAsync()).IsFalse();
    }

    [Test]
    public async Task ReconciledAbsenceFencesADelayedSubmitAndAllowsAnExplicitNewRemoval()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        var operation = Guid.NewGuid();
        var path = Path(asset, operation);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        using var fenced = await AuthTestRequests.PostAsync(fixture, path + "/reconcile", new
        {
        }, token: token);
        await AssertReceiptAsync(fenced, asset, operation, "notApplied");
        using var late = await AuthTestRequests.PutAsync(fixture.Client, path, new
        {
        }, token);

        await Assert.That(late.StatusCode).IsEqualTo(HttpStatusCode.Conflict);

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        await Assert.That(await db.AssetCandidates.Where(row => row.Id == asset).Select(row => row.RemovedFromProjects).SingleAsync()).IsFalse();

        var freshPath = Path(asset, Guid.NewGuid());
        using var unprotected = await fixture.Client.PostAsJsonAsync(freshPath + "/reconcile", new
        {
        });

        await Assert.That(unprotected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);

        using var authorized = await AuthTestRequests.PutAsync(fixture.Client, freshPath, new
        {
        }, token);

        await Assert.That(authorized.StatusCode).IsEqualTo(HttpStatusCode.OK);

        using var stillFenced = await AuthTestRequests.PostAsync(fixture, path + "/reconcile", new
        {
        }, token: token);
        await AssertReceiptAsync(stillFenced, asset, operation, "notApplied");
    }

    [Test]
    public async Task IndependentOperationsOnOneAssetYieldOneRemovalAndOneConflict()
    {
        var pause = new ConcurrentRemovals();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause)),
            environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var asset = await SeedRetiredAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        using var independent = fixture.CreateClient();
        await fixture.SignInAsync(actor, independent);
        var otherToken = await fixture.GetCsrfAsync(independent);
        var paths = new[] { Path(asset, Guid.NewGuid()), Path(asset, Guid.NewGuid()) };
        var first = AuthTestRequests.PutAsync(fixture.Client, paths[0], new
        {
        }, token);
        var second = AuthTestRequests.PutAsync(independent, paths[1], new
        {
        }, otherToken);
        var responses = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(30));
        using var original = responses[0];
        using var concurrent = responses[1];
        var statuses = responses.Select(response => response.StatusCode).Order().ToArray();

        await Assert.That(statuses).IsEquivalentTo(new[] { HttpStatusCode.OK, HttpStatusCode.Conflict });

        for (var i = 0; i < paths.Length; i++)
        {
            using var recovered = await AuthTestRequests.PostAsync(fixture, paths[i] + "/reconcile", new
            {
            }, token: token);
            var receipt = await recovered.Content.ReadFromJsonAsync<JsonElement>();

            await Assert.That(receipt.GetProperty("outcome").GetString()).IsEqualTo(responses[i].IsSuccessStatusCode ? "removed" : "notApplied");
        }
    }

    private sealed class ConcurrentRemovals : DbCommandInterceptor
    {
        private readonly TaskCompletionSource _both = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _arrivals;

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken token = default)
        {
            if (command.CommandText == "LOCK TABLE projects IN EXCLUSIVE MODE")
            {
                if (Interlocked.Increment(ref _arrivals) == 2)
                    _both.TrySetResult();

                await _both.Task.WaitAsync(TimeSpan.FromSeconds(15), token);
            }

            return result;
        }
    }

    private static string Path(Guid asset, Guid operation) => $"/api/v1/admin/assets/{asset:D}/removals/{operation:D}";

    private static async Task AssertReceiptAsync(HttpResponseMessage response, Guid asset, Guid operation, string outcome)
    {
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);

        var receipt = await response.Content.ReadFromJsonAsync<JsonElement>();

        await Assert.That(receipt.GetProperty("assetId").GetGuid()).IsEqualTo(asset);
        await Assert.That(receipt.GetProperty("operationId").GetGuid()).IsEqualTo(operation);
        await Assert.That(receipt.GetProperty("outcome").GetString()).IsEqualTo(outcome);
    }

    private static async Task<Guid> SeedRetiredAsync(HttpsApplicationFixture fixture, Guid actor)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = "Retired fixture",
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
        };
        db.AssetCandidates.Add(asset);
        await db.SaveChangesAsync();
        return asset.Id;
    }
}
