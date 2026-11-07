using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Persistence;
using Spatia.Server.Reviews;
using static Spatia.Server.Tests.ReviewDecisionEndpointTests;
using static Spatia.Server.Tests.ReviewSubmissionEndpointTests;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ReviewCommitTests))]
public sealed class ReviewCommitTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ReviewWrites_FailedCommitRollsBackNewEvidence(bool deciding)
    {
        var failure = new CommitFailure(afterCommit: false);
        var assets = new FixtureAssets();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Services.AddSingleton<IReviewAssetResolver>(assets);
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure));
        }, environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        var decisionId = Guid.NewGuid();
        if (deciding)
        {
            using var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true);
            await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
            await fixture.SignInAsync(data.Educator);
        }
        var token = await fixture.GetCsrfAsync();
        failure.Arm();
        using (var failed = await WriteAsync(fixture, data, deciding, submissionId, decisionId, token))
        {
            await Assert.That(failed.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
            await Assert.That((await failed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString())
                .IsEqualTo("storage_unavailable");
        }
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.ReviewSubmissions.CountAsync()).IsEqualTo(deciding ? 1 : 0);
            await Assert.That(await database.ReviewDecisions.CountAsync()).IsEqualTo(0);
            await Assert.That((await database.Projects.SingleAsync(row => row.Id == data.ProjectId)).Revision).IsEqualTo(0L);
        }
        using var retried = await WriteAsync(fixture, data, deciding, submissionId, decisionId, token);
        await Assert.That(retried.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var stored = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await stored.ReviewSubmissions.SingleAsync()).Id).IsEqualTo(submissionId);
        await Assert.That(await stored.ReviewDecisions.CountAsync()).IsEqualTo(deciding ? 1 : 0);
        if (deciding) { await Assert.That((await stored.ReviewDecisions.SingleAsync()).Id).IsEqualTo(decisionId); }
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ReviewWrites_LostAcknowledgementReplaysAfterRestartWithoutRestoringOlderState(bool deciding)
    {
        var failure = new CommitFailure(afterCommit: true);
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Services.AddSingleton<IReviewAssetResolver>(new FixtureAssets());
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure));
        }, environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        var decisionId = Guid.NewGuid();
        if (deciding)
        {
            using var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 0, true);
            await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
            await fixture.SignInAsync(data.Educator);
        }
        var token = await fixture.GetCsrfAsync();
        failure.Arm();
        using (var uncertain = await WriteAsync(fixture, data, deciding, submissionId, decisionId, token))
        { await Assert.That(uncertain.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable); }
        ReviewSubmission original;
        DateTimeOffset? decidedAt;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            original = await database.ReviewSubmissions.AsNoTracking().SingleAsync();
            await Assert.That(original.Id).IsEqualTo(submissionId);
            decidedAt = deciding ? (await database.ReviewDecisions.AsNoTracking().SingleAsync()).DecidedAt : null;
        }
        if (deciding)
        {
            using var revoked = await DecideAsync(fixture, fixture.Client, data.ProjectId, submissionId,
                Guid.NewGuid(), 0, ReviewDecision.Revoked, "Revoked after the uncertain approval");
            await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.Created);
            await fixture.SignInAsync(data.Student);
        }
        using (var saved = await SaveAsync(fixture, data.ProjectId))
        { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        await fixture.App.StopAsync();
        // The restarted host has the unavailable asset resolver; committed retries need only their stored evidence.
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(deciding ? data.Educator : data.Student);
        using var replayed = await WriteAsync(restarted, data, deciding, submissionId, decisionId, await restarted.GetCsrfAsync());
        await Assert.That(replayed.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var receipt = await replayed.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(receipt.GetProperty("submissionId").GetGuid()).IsEqualTo(submissionId);
        if (deciding)
        {
            await Assert.That(receipt.GetProperty("decisionId").GetGuid()).IsEqualTo(decisionId);
            await Assert.That(receipt.GetProperty("decidedAt").GetDateTimeOffset()).IsEqualTo(decidedAt!.Value);
            await Assert.That(receipt.GetProperty("outcome").GetString()).IsEqualTo(ReviewDecision.Approved);
        }
        else
        {
            await Assert.That(receipt.GetProperty("revision").GetInt64()).IsEqualTo(0L);
            await Assert.That(receipt.GetProperty("submittedAt").GetDateTimeOffset()).IsEqualTo(original.SubmittedAt);
            await Assert.That(receipt.GetProperty("dueAtUnixSeconds").GetInt64()).IsEqualTo(original.DueAtUnixSeconds);
        }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var stored = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var submission = await stored.ReviewSubmissions.AsNoTracking().SingleAsync();
        await Assert.That(submission.DocumentJson).IsEqualTo(original.DocumentJson);
        await Assert.That(submission.AssetReferencesJson).IsEqualTo(original.AssetReferencesJson);
        await Assert.That(await stored.ReviewDecisions.CountAsync()).IsEqualTo(deciding ? 2 : 0);
        if (deciding)
        {
            await Assert.That((await stored.ReviewDecisions.OrderByDescending(row => row.Sequence).FirstAsync()).Outcome)
                .IsEqualTo(ReviewDecision.Revoked);
        }
        var project = await stored.Projects.AsNoTracking().SingleAsync(row => row.Id == data.ProjectId);
        await Assert.That(project.Revision).IsEqualTo(1L);
        using var document = JsonDocument.Parse(project.DocumentJson);
        await Assert.That(document.RootElement.GetProperty("title").GetString()).IsEqualTo("Newer draft");
    }

    private static Task<HttpResponseMessage> WriteAsync(HttpsApplicationFixture fixture, Seeded data, bool deciding,
        Guid submissionId, Guid decisionId, string token) => deciding
        ? DecideAsync(fixture, fixture.Client, data.ProjectId, submissionId, decisionId, 0, ReviewDecision.Approved, "Approved", token)
        : SubmitAsync(fixture, data.ProjectId, submissionId, 0, true, token: token);

    private sealed class CommitFailure(bool afterCommit) : DbTransactionInterceptor
    {
        private int _armed;
        public void Arm() => Interlocked.Exchange(ref _armed, 1);

        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (!afterCommit && Interlocked.Exchange(ref _armed, 0) == 1) { throw new NpgsqlException("Synthetic failure before review commit"); }
            return ValueTask.FromResult(result);
        }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
        {
            if (afterCommit && Interlocked.Exchange(ref _armed, 0) == 1) { throw new NpgsqlException("Synthetic loss after review commit"); }
            return Task.CompletedTask;
        }
    }
}
