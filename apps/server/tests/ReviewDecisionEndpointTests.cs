using System.Data;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;
using static Spatia.Server.Tests.ReviewSubmissionEndpointTests;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ReviewDecisionEndpointTests
{
    [Test]
    public async Task ReviewEvidence_RemainsPrivateAndReadableAfterEditAndRestart()
    {
        var resolver = new FixtureAssets();
        await using var fixture = await CreateFixtureAsync(resolver);
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", "Well done"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var saved = await SaveAsync(fixture, data.ProjectId))
        { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }

        using (var detail = await educator.GetAsync(DetailPath(data.ProjectId, submissionId)))
        {
            await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(detail.Headers.CacheControl?.NoStore).IsTrue();
            var body = await detail.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(body.GetProperty("document").GetProperty("title").GetString()).IsEqualTo("Student draft");
            await Assert.That(body.GetProperty("revision").GetInt64()).IsEqualTo(0L);
            await Assert.That(body.GetProperty("isCurrentSubmission").GetBoolean()).IsFalse();
            await Assert.That(body.GetProperty("assetReferences").GetArrayLength()).IsEqualTo(2);
            await Assert.That(body.GetProperty("decisions")[0].GetProperty("feedback").GetString()).IsEqualTo("Well done");
            await Assert.That(body.GetProperty("latestDecision").GetProperty("outcome").GetString()).IsEqualTo("approved");
        }
        using (var student = await fixture.Client.GetAsync(DetailPath(data.ProjectId, submissionId)))
        { await Assert.That(student.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using var other = fixture.CreateClient();
        await fixture.SignInAsync(data.OtherStudent, other);
        using (var denied = await other.GetAsync(DetailPath(data.ProjectId, submissionId)))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var denied = await other.GetAsync($"/api/projects/{data.ProjectId:D}/submissions"))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        using var admin = fixture.CreateClient();
        await fixture.SignInAsync(administrator, admin);
        using (var denied = await admin.GetAsync(DetailPath(data.ProjectId, submissionId)))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var denied = await DecideAsync(fixture, admin, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", ""))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.ClassroomMembers.Where(row => row.ClassroomId == data.ClassroomId && row.UserId == data.Student)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.IsActive, false));
        }
        using (var denied = await fixture.Client.GetAsync(DetailPath(data.ProjectId, submissionId)))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await fixture.App.StopAsync();
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(data.Educator);
        using var afterRestart = await restarted.Client.GetAsync(DetailPath(data.ProjectId, submissionId));
        await Assert.That(afterRestart.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var history = await afterRestart.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(history.GetProperty("document").GetProperty("title").GetString()).IsEqualTo("Student draft");
        await Assert.That(history.GetProperty("decisions")[0].GetProperty("outcome").GetString()).IsEqualTo("approved");
    }

    [Test]
    [Arguments("returned")]
    [Arguments("revoked")]
    public async Task ReviewDecision_ReturnOrRevocationRequiresANewSubmission(string terminalOutcome)
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        var decisionId = Guid.NewGuid();
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submissionId, decisionId, 0, "approved", "OK"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        await Assert.That(await ApprovalAsync(fixture, data)).IsEqualTo(ReviewApprovalState.Approved);
        using (var replay = await DecideAsync(fixture, educator, data.ProjectId, submissionId, decisionId, 0, "approved", "OK"))
        { await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var changed = await DecideAsync(fixture, educator, data.ProjectId, submissionId, decisionId, 0, "approved", "Changed"))
        { await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        using (var terminal = await DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, terminalOutcome, "Please revisit"))
        { await Assert.That(terminal.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        await Assert.That(await ApprovalAsync(fixture, data)).IsEqualTo(ReviewApprovalState.ApprovalRequired);
        using (var denied = await DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", ""))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        var next = Guid.NewGuid();
        using (var resubmitted = await SubmitAsync(fixture, data.ProjectId, next, 0, true))
        { await Assert.That(resubmitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, next, Guid.NewGuid(), 0, "approved", ""))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        await Assert.That(await ApprovalAsync(fixture, data)).IsEqualTo(ReviewApprovalState.Approved);
        using (var saved = await SaveAsync(fixture, data.ProjectId))
        { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        await Assert.That(await ApprovalAsync(fixture, data)).IsEqualTo(ReviewApprovalState.ApprovalRequired);
        using (var stale = await DecideAsync(fixture, educator, data.ProjectId, next, Guid.NewGuid(), 0, "approved", ""))
        { await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
    }

    [Test]
    public async Task ReviewDecision_RejectsUnauthorizedInvalidAndConcurrentChangedIntent()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var denied = await DecideAsync(fixture, fixture.Client, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", ""))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }
        var foreignEducator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        using var foreign = fixture.CreateClient();
        await fixture.SignInAsync(foreignEducator, foreign);
        using (var denied = await DecideAsync(fixture, foreign, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", ""))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var invalid = await DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.Empty, 0, "approved", ""))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var invalid = await DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", "bad\0text"))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var invalid = await DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, "revoked", ""))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        var id = Guid.NewGuid();
        var token = await fixture.GetCsrfAsync(educator);
        var results = await Task.WhenAll(
            DecideAsync(fixture, educator, data.ProjectId, submissionId, id, 0, "approved", "Same", token),
            DecideAsync(fixture, educator, data.ProjectId, submissionId, id, 0, "approved", "Same", token));
        try
        {
            await Assert.That(results.Count(result => result.StatusCode == HttpStatusCode.Created)).IsEqualTo(1);
            await Assert.That(results.Count(result => result.StatusCode == HttpStatusCode.OK)).IsEqualTo(1);
        }
        finally { foreach (var response in results) { response.Dispose(); } }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewDecisions.CountAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ReviewDecision_WaitsForProjectLockAndRechecksRevisionAndRoster(bool removeEducator)
    {
        var resolver = new FixtureAssets();
        var probe = new ProjectLockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Services.AddSingleton<IReviewAssetResolver>(resolver);
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe));
        }, environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        var token = await fixture.GetCsrfAsync(educator);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM projects WHERE id = {data.ProjectId} FOR UPDATE").ToArrayAsync();
        var blocker = await database.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync();
        if (removeEducator)
        {
            await database.ClassroomMembers.Where(row => row.ClassroomId == data.ClassroomId && row.UserId == data.Educator)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.IsActive, false));
        }
        else
        {
            await database.Projects.Where(row => row.Id == data.ProjectId)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.Revision, 1));
        }
        probe.Arm();
        var deciding = DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", "", token);
        var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await WaitBlockedAsync(fixture, waiter, blocker);
        await transaction.CommitAsync();
        using var result = await deciding.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(result.StatusCode).IsEqualTo(removeEducator ? HttpStatusCode.NotFound : HttpStatusCode.Conflict);
        await Assert.That(await database.ReviewDecisions.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task ReviewDecision_WaitsForResubmissionAndRejectsTheOlderSubmission()
    {
        var resolver = new FixtureAssets();
        var pause = new CommitPause();
        var probe = new ProjectLockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Services.AddSingleton<IReviewAssetResolver>(resolver);
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause, probe));
        }, environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        var original = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, original, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        var educatorToken = await fixture.GetCsrfAsync(educator);
        var studentToken = await fixture.GetCsrfAsync();
        pause.Arm();
        var submitting = SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, true, token: studentToken);
        var blocker = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        probe.Arm();
        var deciding = DecideAsync(fixture, educator, data.ProjectId, original, Guid.NewGuid(), 0, "approved", "", educatorToken);
        try
        {
            var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, blocker);
        }
        finally { pause.Release.TrySetResult(); }
        using var submission = await submitting.WaitAsync(TimeSpan.FromSeconds(10));
        using var decision = await deciding.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(submission.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await Assert.That(decision.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.ReviewSubmissions.CountAsync()).IsEqualTo(2);
        await Assert.That(await database.ReviewDecisions.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task ReviewReads_PagePrivateSubmissionsAndDecisionHistory()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, first, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, second, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, second, Guid.NewGuid(), 0, "approved", "Approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var revoked = await DecideAsync(fixture, educator, data.ProjectId, second, Guid.NewGuid(), 0, "revoked", "Revoked"))
        { await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var listPath = $"/api/projects/{data.ProjectId:D}/submissions";
        using var pageOne = await educator.GetAsync(listPath + "?limit=1");
        var one = await pageOne.Content.ReadFromJsonAsync<JsonElement>();
        using var pageTwo = await educator.GetAsync(listPath + "?limit=1&cursor=" + one.GetProperty("nextCursor").GetString());
        var two = await pageTwo.Content.ReadFromJsonAsync<JsonElement>();
        var found = new[] { one.GetProperty("items")[0].GetProperty("submissionId").GetGuid(),
            two.GetProperty("items")[0].GetProperty("submissionId").GetGuid() };
        await Assert.That(found.ToHashSet().SetEquals([first, second])).IsTrue();
        await Assert.That(two.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        using var detailOne = await educator.GetAsync(DetailPath(data.ProjectId, second) + "?limit=1");
        var detail = await detailOne.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(detail.GetProperty("isCurrentSubmission").GetBoolean()).IsTrue();
        await Assert.That(detail.GetProperty("latestDecision").GetProperty("outcome").GetString()).IsEqualTo("revoked");
        using var detailTwo = await educator.GetAsync(DetailPath(data.ProjectId, second) + "?limit=1&cursor=" + detail.GetProperty("nextCursor").GetString());
        var other = await detailTwo.Content.ReadFromJsonAsync<JsonElement>();
        var outcomes = new[] { detail.GetProperty("decisions")[0].GetProperty("outcome").GetString(),
            other.GetProperty("decisions")[0].GetProperty("outcome").GetString() };
        await Assert.That(outcomes.ToHashSet().SetEquals(["approved", "revoked"])).IsTrue();
        using var invalid = await educator.GetAsync(listPath + "?limit=21");
        await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ReviewWrites_RollBackIfTheAccountStampChangesBeforeCommit(bool deciding)
    {
        var assets = new BlockingAssets();
        var pause = new ReviewInsertPause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Services.AddSingleton<IReviewAssetResolver>(assets);
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause));
        }, environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        Task<HttpResponseMessage> writing;
        Task entered;
        Guid actor;
        Action release;
        if (deciding)
        {
            using var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true);
            await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
            var educator = fixture.CreateClient();
            await fixture.SignInAsync(data.Educator, educator);
            var token = await fixture.GetCsrfAsync(educator);
            pause.Arm();
            writing = DecideAsync(fixture, educator, data.ProjectId, submissionId, Guid.NewGuid(), 0, "approved", "", token);
            entered = pause.Entered.Task;
            actor = data.Educator;
            release = () => pause.Release.TrySetResult();
        }
        else
        {
            var token = await fixture.GetCsrfAsync();
            assets.Arm();
            writing = SubmitAsync(fixture, data.ProjectId, submissionId, 0, true, token: token);
            entered = assets.Entered.Task;
            actor = data.Student;
            release = () => assets.Release.TrySetResult();
        }
        try
        {
            await entered.WaitAsync(TimeSpan.FromSeconds(10));
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Users.Where(row => row.Id == actor)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.SecurityStamp, Guid.NewGuid().ToString("N")));
        }
        finally { release(); }
        using var response = await writing.WaitAsync(TimeSpan.FromSeconds(10));
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var stored = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await stored.ReviewSubmissions.CountAsync()).IsEqualTo(deciding ? 1 : 0);
        await Assert.That(await stored.ReviewDecisions.CountAsync()).IsEqualTo(0);
    }

    private static string DetailPath(Guid project, Guid submission) => $"/api/projects/{project:D}/submissions/{submission:D}";

    private static async Task<HttpResponseMessage> DecideAsync(HttpsApplicationFixture fixture, HttpClient client, Guid project,
        Guid submission, Guid decision, long revision, string outcome, string feedback, string? token = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, DetailPath(project, submission) + "/decisions")
        {
            Content = JsonContent.Create(new { decisionId = decision, expectedRevision = revision, outcome, feedback }),
        };
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(request);
    }

    private static async Task<ReviewApprovalState> ApprovalAsync(HttpsApplicationFixture fixture, Seeded data)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        var project = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == data.ProjectId);
        var snapshot = new ProjectAccessSnapshot(data.Educator, project.Id, project.OrganizationId, project.IsArchived,
            project.Revision, project.SchemaVersion, project.DocumentJson, project.UpdatedAt,
            null, null, null, true, true, true);
        return await ReviewApproval.CheckLockedAsync(database, snapshot);
    }

    private static async Task WaitBlockedAsync(HttpsApplicationFixture fixture, int waiter, int blocker)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var observer = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await observer.Database.SqlQuery<bool>($"SELECT {blocker} = ANY(pg_blocking_pids({waiter})) AS \"Value\"").SingleAsync(timeout.Token))
        { await Task.Delay(10, timeout.Token); }
    }

    private sealed class ProjectLockProbe : DbCommandInterceptor
    {
        private int _armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("FROM projects", StringComparison.Ordinal)
                && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }

    private sealed class CommitPause : DbTransactionInterceptor
    {
        private int _armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult(((NpgsqlConnection)transaction.Connection!).ProcessID);
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }

    private sealed class BlockingAssets : IReviewAssetResolver
    {
        private int _armed;
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public async Task<IReadOnlyCollection<ReviewAssetReference>?> ResolveAsync(ApplicationDbContext database,
            ProjectAccessSnapshot project, IReadOnlySet<string> assetIds, CancellationToken cancellationToken)
        {
            if (Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return assetIds.Select(id => new ReviewAssetReference(id, new string('a', 64))).ToArray();
        }
    }

    private sealed class ReviewInsertPause : DbCommandInterceptor
    {
        private int _armed;
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("INSERT INTO review_decisions", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }
}
