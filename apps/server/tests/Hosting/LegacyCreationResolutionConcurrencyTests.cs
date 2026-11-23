using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

public sealed partial class LegacyCreationResolutionTests
{
    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ConcurrentSameDecisionAndDelayedRawPostsCommitOneResource(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var path = Path(kind, source);
        var body = Body(kind, document);
        var before = await CountsAsync(fixture);
        var token = await fixture.GetCsrfAsync();
        var responses = await Task.WhenAll(
            ResolveAsync(fixture, path, "createAfter=initial", body, token: token),
            ResolveAsync(fixture, path, "createAfter=initial", body, token: token),
            AuthTestRequests.PostAsync(fixture, path, body, token: token));

        try
        {
            var decisions = responses.Take(2).ToArray();
            var created = decisions.Single(response => response.StatusCode == HttpStatusCode.Created);

            await Assert.That(decisions.Count(response => response.StatusCode == HttpStatusCode.OK)).IsEqualTo(1);

            var original = await created.Content.ReadAsStringAsync();

            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.Created)).IsEqualTo(1);

            foreach (var response in responses.Where(response => !ReferenceEquals(response, created)))
            {
                if (response.StatusCode == HttpStatusCode.BadRequest)
                {
                    await MissingAsync(response, path);
                }
                else
                {
                    await SuccessAsync(response, HttpStatusCode.OK, "created");

                    await Assert.That(await response.Content.ReadAsStringAsync()).IsEqualTo(original);
                }
            }

            using var delayed = await AuthTestRequests.PostAsync(fixture, path, body, token: token);
            await SuccessAsync(delayed, HttpStatusCode.OK, "created");

            await Assert.That(await delayed.Content.ReadAsStringAsync()).IsEqualTo(original);
        }
        finally { foreach (var response in responses) response.Dispose(); }

        await AssertCountsAsync(fixture, before, kind, 1, 1);
    }

    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ConcurrentConflictingSelectionsChooseExactlyOneImmutableBinding(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var candidates = new[] { await SeedAsync(fixture, kind == "class" ? "class" : "project"), await SeedAsync(fixture, kind == "class" ? "class" : "project") };
        var before = await CountsAsync(fixture);
        var path = Path(kind, source);
        var body = Body(kind, document);
        var token = await fixture.GetCsrfAsync();
        var responses = await Task.WhenAll(candidates.Select(id => ResolveAsync(fixture, path, $"useExisting={id:D}", body, token: token)));

        try
        {
            var selected = responses.Single(response => response.StatusCode == HttpStatusCode.OK);
            var id = Id(kind, await selected.Content.ReadFromJsonAsync<JsonElement>());

            await Assert.That(candidates.Contains(id)).IsTrue();

            await AuthTestRequests.AssertProblemAsync(responses.Single(response => response.StatusCode != HttpStatusCode.OK), HttpStatusCode.Conflict, "legacy_creation_resolution_conflict");
            using var delayed = await AuthTestRequests.PostAsync(fixture, path, body, token: token);
            await SuccessAsync(delayed, HttpStatusCode.OK, "existing");

            await Assert.That(Id(kind, await delayed.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(id);
        }
        finally { foreach (var response in responses) response.Dispose(); }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before with
        {
            Bindings = before.Bindings + 1
        });
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task SelectionRacingCreationKeepsFirstCommittedDecisionAndNeverCreatesAnExtraResource(bool createWins)
    {
        var pause = new ResolutionSavePause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause)), environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var candidate = await SeedAsync(fixture);
        var predecessor = (await HeadAsync(fixture, "project")).GetProperty("operationId").GetGuid();

        using (var ack = await AckAsync(fixture, "project", predecessor))
        {
            await Assert.That(ack.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }

        var before = await CountsAsync(fixture);
        var body = Body("project");
        var create = $"createAfter={predecessor:D}";
        var select = $"useExisting={candidate:D}";
        var token = await fixture.GetCsrfAsync();
        pause.Armed = true;
        var first = ResolveAsync(fixture, Path("project"), createWins ? create : select, body, token: token);
        Task<HttpResponseMessage>? second = null;

        try
        {
            await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            second = ResolveAsync(fixture, Path("project"), createWins ? select : create, body, token: token);
        }
        finally { pause.Release.TrySetResult(); }

        using var winner = await first;
        await SuccessAsync(winner, createWins ? HttpStatusCode.Created : HttpStatusCode.OK, createWins ? "created" : "existing");
        using var loser = await second!;
        await AuthTestRequests.AssertProblemAsync(loser, HttpStatusCode.Conflict, "legacy_creation_resolution_conflict");
        using var delayed = await AuthTestRequests.PostAsync(fixture, Path("project"), body, token: token);
        await SuccessAsync(delayed, HttpStatusCode.OK, createWins ? "created" : "existing");

        await Assert.That(await delayed.Content.ReadAsStringAsync()).IsEqualTo(await winner.Content.ReadAsStringAsync());

        await AssertCountsAsync(fixture, before, "project", createWins ? 1 : 0, createWins ? 1 : 0);
    }

    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task CreateDecisionRequiresAcknowledgedCurrentPredecessorAndLateAckCannotClearNextGeneration(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var path = Path(kind, source);
        var operation = Guid.NewGuid();
        var keyed = Body(kind, document);
        keyed["operationId"] = operation.ToString("D");

        using (var created = await AuthTestRequests.PostAsync(fixture, path, keyed))
        {
            await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }

        var before = await CountsAsync(fixture);
        var body = Body(kind, document);

        foreach (var predecessor in new[] { "initial", operation.ToString("D"), Guid.NewGuid().ToString("D") })
        {
            using var blocked = await ResolveAsync(fixture, path, "createAfter=" + predecessor, body);
            await AuthTestRequests.AssertProblemAsync(blocked, HttpStatusCode.Conflict, "creation_state_changed");
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);

        using (var ack = await AckAsync(fixture, kind, operation))
        {
            await Assert.That(ack.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }

        using (var stale = await ResolveAsync(fixture, path, "createAfter=initial", body))
        {
            await AuthTestRequests.AssertProblemAsync(stale, HttpStatusCode.Conflict, "creation_state_changed");
        }

        using (var created = await ResolveAsync(fixture, path, $"createAfter={operation:D}", body))
        {
            await SuccessAsync(created, HttpStatusCode.Created, "created");
        }

        var headBefore = await HeadAsync(fixture, kind);

        await Assert.That(headBefore.GetProperty("state").GetString()).IsEqualTo("unacknowledged");

        var next = headBefore.GetProperty("operationId").GetGuid();

        await Assert.That(next).IsNotEqualTo(operation);

        using (var lateAck = await AckAsync(fixture, kind, operation))
        {
            await Assert.That(lateAck.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }

        var headAfter = await HeadAsync(fixture, kind);

        await Assert.That(headAfter.GetProperty("operationId").GetGuid()).IsEqualTo(next);
        await Assert.That(headAfter.GetProperty("state").GetString()).IsEqualTo("unacknowledged");

        using (var alteredDecision = await ResolveAsync(fixture, path, $"createAfter={next:D}", body))
        {
            await AuthTestRequests.AssertProblemAsync(alteredDecision, HttpStatusCode.Conflict, "legacy_creation_resolution_conflict");
        }

        await AssertCountsAsync(fixture, before, kind, 1, 1);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task CommitFailureKeepsResourceReceiptAndBindingAtomicAndLostSuccessReopens(bool afterCommit)
    {
        var failure = new ResolutionCommitFailure(afterCommit);
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var body = Body("project");
        var token = await fixture.GetCsrfAsync();
        failure.Armed = true;

        using (var interrupted = await ResolveAsync(fixture, Path("project"), "createAfter=initial", body, token: token))
        {
            await AuthTestRequests.AssertProblemAsync(interrupted, HttpStatusCode.ServiceUnavailable, "storage_unavailable");
        }

        var expected = afterCommit ? new Counts(1, 0, 0, 1, 1) : new Counts(0, 0, 0, 0, 0);

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(expected);

        await fixture.App.StopAsync();
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);

        if (!afterCommit)
        {
            using var raw = await AuthTestRequests.PostAsync(reopened, Path("project"), body);
            await MissingAsync(raw, Path("project"));
        }

        using var recovered = await ResolveAsync(reopened, Path("project"), "createAfter=initial", body);
        await SuccessAsync(recovered, afterCommit ? HttpStatusCode.OK : HttpStatusCode.Created, "created");
        var id = Id("project", await recovered.Content.ReadFromJsonAsync<JsonElement>());
        using var replay = await AuthTestRequests.PostAsync(reopened, Path("project"), body);
        await SuccessAsync(replay, HttpStatusCode.OK, "created");

        await Assert.That(Id("project", await replay.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(id);
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(new Counts(1, 0, 0, 1, 1));
    }

    private static async Task<HttpResponseMessage> AckAsync(HttpsApplicationFixture fixture, string purpose, Guid operation) =>
        await AuthTestRequests.PostAsync(fixture, $"/api/v1/creation-operations/{purpose}/{operation:D}/acknowledge", new
        {
        });

    private static async Task<JsonElement> HeadAsync(HttpsApplicationFixture fixture, string purpose)
    {
        using var response = await fixture.Client.GetAsync($"/api/v1/creation-operations/{purpose}");

        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);

        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private sealed class ResolutionCommitFailure(bool afterCommit) : DbTransactionInterceptor
    {
        internal bool Armed
        {
            get; set;
        }

        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction, TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed && !afterCommit)
            {
                Armed = false;
                throw new NpgsqlException("Synthetic legacy resolution commit failure.");
            }

            return ValueTask.FromResult(result);
        }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (Armed && afterCommit)
            {
                Armed = false;
                throw new NpgsqlException("Synthetic lost legacy resolution reply.");
            }

            return Task.CompletedTask;
        }
    }

    private sealed class ResolutionSavePause : SaveChangesInterceptor
    {
        internal bool Armed
        {
            get; set;
        }
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed)
            {
                Armed = false;
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }

            return result;
        }
    }
}
