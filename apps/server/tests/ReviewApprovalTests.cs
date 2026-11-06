using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ReviewApprovalTests))]
public sealed class ReviewApprovalTests
{
    [Test]
    public async Task ReviewApproval_RequiresLatestApprovalForTheExactCurrentRevision()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var data = await ReviewPersistenceTests.SeedAsync(fixture);
        await Assert.That(await CheckAsync(fixture, data, data.SourceId, 0)).IsEqualTo(ReviewApprovalState.UnverifiedOrigin);
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 7)).IsEqualTo(ReviewApprovalState.ApprovalRequired);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ReviewSubmissions.Add(ReviewPersistenceTests.Submission(data));
            database.ReviewDecisions.Add(ReviewPersistenceTests.Decision(data));
            await database.SaveChangesAsync();
        }
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 7)).IsEqualTo(ReviewApprovalState.Approved);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Projects.Where(row => row.Id == data.ProjectId)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 8));
        }
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 7)).IsEqualTo(ReviewApprovalState.StaleProject);
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 8)).IsEqualTo(ReviewApprovalState.ApprovalRequired);
        var nextId = Guid.NewGuid();
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var previous = ReviewPersistenceTests.Submission(data);
            database.ReviewSubmissions.Add(new ReviewSubmission
            {
                Id = nextId,
                ProjectId = data.ProjectId,
                StudentId = data.StudentId,
                Sequence = 2,
                SourceRevision = 8,
                DueAtUnixSeconds = previous.DueAtUnixSeconds,
                SchemaVersion = previous.SchemaVersion,
                CompletionConfirmed = true,
                DocumentJson = previous.DocumentJson,
                AssetReferencesJson = previous.AssetReferencesJson,
                RequestDigest = new byte[32],
            });
            await database.SaveChangesAsync();
        }
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 8)).IsEqualTo(ReviewApprovalState.ApprovalRequired);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ReviewDecisions.Add(new ReviewDecision
            {
                Id = Guid.NewGuid(),
                SubmissionId = nextId,
                EducatorId = data.EducatorId,
                Sequence = 1,
                Outcome = ReviewDecision.Approved,
                Feedback = "",
                RequestDigest = new byte[32]
            });
            await database.SaveChangesAsync();
        }
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 8)).IsEqualTo(ReviewApprovalState.Approved);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ReviewDecisions.Add(new ReviewDecision
            {
                Id = Guid.NewGuid(),
                SubmissionId = nextId,
                EducatorId = data.EducatorId,
                Sequence = 2,
                Outcome = ReviewDecision.Revoked,
                Feedback = "Changed",
                RequestDigest = new byte[32]
            });
            await database.SaveChangesAsync();
        }
        await Assert.That(await CheckAsync(fixture, data, data.ProjectId, 8)).IsEqualTo(ReviewApprovalState.ApprovalRequired);
        await using var verify = fixture.Services.CreateAsyncScope();
        await Assert.That(await verify.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewDecisions.CountAsync()).IsEqualTo(3);
    }

    [Test]
    public async Task ReviewApproval_WaitingForAProjectWriteRejectsTheOldSnapshot()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var data = await ReviewPersistenceTests.SeedAsync(fixture);
        await using var firstScope = fixture.Services.CreateAsyncScope();
        await using var secondScope = fixture.Services.CreateAsyncScope();
        await using var observerScope = fixture.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var second = secondScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var observer = observerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var firstTransaction = await first.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await first.Projects.Where(row => row.Id == data.ProjectId).ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 8));
        var blocker = await first.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync();
        await using var secondTransaction = await second.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        var waiter = await second.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync();
        var checking = ReviewApproval.CheckLockedAsync(second, Snapshot(data, data.ProjectId, 7));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await observer.Database.SqlQuery<bool>($"SELECT {blocker} = ANY(pg_blocking_pids({waiter})) AS \"Value\"")
            .SingleAsync(timeout.Token))
        {
            await Task.Delay(10, timeout.Token);
        }
        await firstTransaction.CommitAsync();
        await Assert.That(await checking.WaitAsync(TimeSpan.FromSeconds(10))).IsEqualTo(ReviewApprovalState.StaleProject);
    }

    [Test]
    public async Task ReviewApproval_RequiresTheCallerTransaction()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var data = await ReviewPersistenceTests.SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await ReviewApproval.CheckLockedAsync(database, Snapshot(data, data.ProjectId, 7)));
    }

    private static async Task<ReviewApprovalState> CheckAsync(PostgresAccountFixture fixture,
        ReviewPersistenceTests.Seeded data, Guid projectId, long revision)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        return await ReviewApproval.CheckLockedAsync(database, Snapshot(data, projectId, revision));
    }

    private static ProjectAccessSnapshot Snapshot(ReviewPersistenceTests.Seeded data, Guid projectId, long revision) =>
        new(data.EducatorId, projectId, data.OrganizationId, false, revision, 1, "{}", DateTimeOffset.UnixEpoch,
            null, null, null, true, true, true);
}
