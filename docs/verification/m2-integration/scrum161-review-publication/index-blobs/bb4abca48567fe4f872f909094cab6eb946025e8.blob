using System.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

public sealed partial class PublicationCoordinatorTests
{
    [Test]
    [Arguments("before-commit")]
    [Arguments("after-commit")]
    [Arguments("canceled-before-commit")]
    [Arguments("canceled-after-commit")]
    public async Task PublicationCoordinator_UncertainOutcomeHasNoAcknowledgementAndSameIdReconciles(string stage)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        using var cancellation = new CancellationTokenSource();
        var request = Request();
        var commit = new PublicationCommitProbe();
        var durable = stage.EndsWith("after-commit", StringComparison.Ordinal);
        if (durable)
        {
            commit.After = () =>
            {
                if (stage.StartsWith("canceled", StringComparison.Ordinal)) { cancellation.Cancel(); }
                else { throw new InvalidOperationException("fixture lost acknowledgement"); }
            };
        }
        else
        {
            commit.Before = (_, token) =>
            {
                if (stage.StartsWith("canceled", StringComparison.Ordinal))
                {
                    cancellation.Cancel();
                    token.ThrowIfCancellationRequested();
                }
                throw new InvalidOperationException("fixture failed commit");
            };
        }
        await using (var database = fixture.Database(commit))
        {
            var operation = fixture.Coordinator(database).PublishAsync(fixture.Context(), fixture.ProjectId, request, cancellation.Token);
            if (stage.StartsWith("canceled", StringComparison.Ordinal))
            {
                await Assert.ThrowsAsync<OperationCanceledException>(() => operation);
            }
            else { await Assert.ThrowsAsync<InvalidOperationException>(() => operation); }
            await Assert.That(database.Database.CurrentTransaction).IsNull();
        }
        await fixture.AssertCountAsync(durable ? 1 : 0);
        var original = durable ? await fixture.ReadAsync(request.PublicationId) : null;
        var retried = await fixture.PublishAsync(request);
        await AssertCommittedAsync(retried, request, fixture.ProjectId, durable);
        if (original is not null)
        {
            await Assert.That(retried.Acknowledgement!.CreatedAt).IsEqualTo(original.CreatedAt);
            await Assert.That((await fixture.ReadAsync(request.PublicationId)).DocumentJson).IsEqualTo(original.DocumentJson);
        }
        await fixture.AssertCountAsync(1);
    }

    [Test]
    [Arguments("prepare")]
    [Arguments("stage")]
    [Arguments("commit")]
    public async Task PublicationCoordinator_ExpiredSessionSuppressesAcknowledgementAtEveryStage(string stage)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        var commit = new PublicationCommitProbe();
        void Expire() => fixture.Clock.Advance(TimeSpan.FromHours(2));
        if (stage == "prepare") { fixture.Integration.BeforePrepare = _ => { Expire(); return Task.CompletedTask; }; }
        if (stage == "stage") { fixture.Integration.OnStage = _ => { Expire(); return Task.CompletedTask; }; }
        if (stage == "commit") { commit.After = Expire; }
        await using var database = fixture.Database(commit);
        var result = await fixture.Coordinator(database).PublishAsync(fixture.Context(), fixture.ProjectId, request);
        await AssertNoAcknowledgementAsync(result);
        await Assert.That(result.AccessFailure).IsEqualTo((ProjectAccessFailure?)ProjectAccessFailure.AuthenticationRequired);
        await fixture.AssertCountAsync(stage == "commit" ? 1 : 0);
        fixture.Integration.BeforePrepare = null;
        fixture.Integration.OnStage = null;
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, stage == "commit");
    }

    [Test]
    [Arguments("denial")]
    [Arguments("exception")]
    public async Task PublicationCoordinator_PolicyStagingAndLedgerRollBackTogether(string failure)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        await using var observer = fixture.Database();
        await observer.Database.ExecuteSqlRawAsync("CREATE TABLE fixture_policy (id uuid PRIMARY KEY REFERENCES publications(id))");
        fixture.Integration.OnStage = async database =>
        {
            await database.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO fixture_policy (id) VALUES ({request.PublicationId})");
            await fixture.AssertCountAsync(0);
            if (failure == "exception") { throw new InvalidOperationException("fixture stage failed"); }
        };
        fixture.Integration.StageFailure = PublicationRejection.PolicyDenied;
        if (failure == "exception") { await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.PublishAsync(request)); }
        else { await AssertRejectedAsync(await fixture.PublishAsync(request), PublicationRejection.PolicyDenied); }
        await fixture.AssertCountAsync(0);
        await Assert.That(await observer.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM fixture_policy").SingleAsync())
            .IsEqualTo(0);
        fixture.Integration.StageFailure = null;
        fixture.Integration.OnStage = async database =>
            await database.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO fixture_policy (id) VALUES ({request.PublicationId})");
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, false);
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, true);
        await Assert.That(await observer.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM fixture_policy").SingleAsync())
            .IsEqualTo(1);
        await fixture.AssertCountAsync(1);
    }

    [Test]
    [Arguments("check")]
    [Arguments("unrelated-unique")]
    [Arguments("suppressed-insert")]
    public async Task PublicationCoordinator_DatabaseFailureIsNeverMisreportedAsReplayOrIdConflict(string failure)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        await using var setup = fixture.Database();
        if (failure == "check")
        {
            await setup.Database.ExecuteSqlRawAsync("ALTER TABLE publications ADD CONSTRAINT fixture_reject CHECK (source_revision < 0)");
        }
        else if (failure == "unrelated-unique")
        {
            await setup.Database.ExecuteSqlRawAsync("CREATE UNIQUE INDEX fixture_revision_unique ON publications(project_id, source_revision)");
            await fixture.PublishAsync(Request());
        }
        else
        {
            await setup.Database.ExecuteSqlRawAsync("""
                CREATE FUNCTION fixture_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
                CREATE TRIGGER fixture_suppress BEFORE INSERT ON publications FOR EACH ROW EXECUTE FUNCTION fixture_suppress();
                """);
        }
        if (failure == "suppressed-insert")
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.PublishAsync(Request()));
        }
        else
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => fixture.PublishAsync(Request()));
            await Assert.That(error!.SqlState).IsEqualTo(failure == "check" ? PostgresErrorCodes.CheckViolation : PostgresErrorCodes.UniqueViolation);
        }
        await fixture.AssertCountAsync(failure == "unrelated-unique" ? 1 : 0);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationCoordinator_CancellationBeforeOrDuringLockLeavesNoTransactionOrClaim(bool duringLock)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        using var cancellation = new CancellationTokenSource();
        await using var holder = fixture.Database();
        await using var held = await holder.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        if (duringLock)
        {
            await holder.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM projects WHERE id = {fixture.ProjectId} FOR UPDATE");
        }
        else { cancellation.Cancel(); }
        await using var database = fixture.Database();
        await database.Database.OpenConnectionAsync();
        var request = Request();
        var pending = fixture.Coordinator(database).PublishAsync(fixture.Context(), fixture.ProjectId, request, cancellation.Token);
        try
        {
            if (duringLock) { await fixture.WaitBlockedAsync(Pid(database), Pid(holder)); }
            cancellation.Cancel();
            await Assert.ThrowsAsync<OperationCanceledException>(() => pending);
        }
        finally
        {
            cancellation.Cancel();
            await held.RollbackAsync();
        }
        await Assert.That(database.Database.CurrentTransaction).IsNull();
        await fixture.AssertCountAsync(0);
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, false);
    }
}
