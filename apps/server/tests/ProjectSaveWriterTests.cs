using System.Collections.Immutable;
using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectSaveWriterTests
{
    private static readonly Guid ProjectId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid OrganizationId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid ActorId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly Guid MutationId = Guid.Parse("44444444-4444-4444-8444-444444444444");
    private static readonly byte[] Digest = Enumerable.Repeat((byte)42, 32).ToArray();

    [Test]
    public async Task SaveWriter_StagesAllFieldsAndBecomesVisibleOnlyAfterCallerCommit()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        var document = Document(2, "A child's '; DROP TABLE projects; -- scene");
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await LockRowAsync(database);

        var staged = await new ProjectSaveWriter(database).TryStageAsync(
            Snapshot(original), original.Revision, MutationId, 2, document, Digest);

        await Assert.That(staged).IsTrue();
        var pending = await database.Projects.AsNoTracking().SingleAsync();
        await Assert.That(pending.Revision).IsEqualTo(original.Revision + 1);
        await AssertSameAsync(await ReadAsync(fixture), original);
        await transaction.CommitAsync();

        var stored = await ReadAsync(fixture);
        await Assert.That(stored.Id).IsEqualTo(ProjectId);
        await Assert.That(stored.OrganizationId).IsEqualTo(OrganizationId);
        await Assert.That(stored.IsArchived).IsFalse();
        await Assert.That(stored.SchemaVersion).IsEqualTo(2);
        await Assert.That(stored.Revision).IsEqualTo(original.Revision + 1);
        await Assert.That(stored.UpdatedAt > original.UpdatedAt).IsTrue();
        await Assert.That(stored.UpdatedAt).IsEqualTo(pending.UpdatedAt);
        await Assert.That(stored.UpdatedAt.Offset).IsEqualTo(TimeSpan.Zero);
        await Assert.That(stored.LastMutationActorId).IsEqualTo((Guid?)ActorId);
        await Assert.That(stored.LastMutationId).IsEqualTo((Guid?)MutationId);
        await Assert.That(stored.LastMutationDigest!.SequenceEqual(Digest)).IsTrue();
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(stored.DocumentJson), JsonNode.Parse(document))).IsTrue();
        var assignment = await database.ProjectAssignments.AsNoTracking().SingleAsync();
        await Assert.That(assignment.CanEdit).IsTrue();
        await Assert.That(assignment.CanManage).IsFalse();
        await Assert.That(assignment.CanPublish).IsFalse();
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task SaveWriter_RollbackOrFailedCommitPreservesDraftAndRelatedWrites(bool failCommit)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using (var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            await LockRowAsync(database);
            await Assert.That(await new ProjectSaveWriter(database).TryStageAsync(
                Snapshot(original), original.Revision, MutationId, 2, Document(2, "Pending"), Digest)).IsTrue();
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE project_assignments SET can_publish = TRUE WHERE project_id = {ProjectId}");

            if (failCommit)
            {
                await database.Database.ExecuteSqlRawAsync("""
                    CREATE TABLE save_commit_guard (
                        user_id uuid REFERENCES "AspNetUsers"("Id") DEFERRABLE INITIALLY DEFERRED
                    )
                    """);
                await database.Database.ExecuteSqlInterpolatedAsync(
                    $"INSERT INTO save_commit_guard (user_id) VALUES ({Guid.NewGuid()})");
                var failure = await Assert.ThrowsAsync<PostgresException>(async () => await transaction.CommitAsync());
                await Assert.That(failure!.SqlState).IsEqualTo(PostgresErrorCodes.ForeignKeyViolation);
            }
            else
            {
                await transaction.RollbackAsync();
            }
        }

        await AssertSameAsync(await ReadAsync(fixture), original);
        await using var reopened = fixture.Services.CreateAsyncScope();
        var stored = reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await stored.ProjectAssignments.SingleAsync()).CanPublish).IsFalse();
    }

    [Test]
    public async Task SaveWriter_ConstraintFailureLeavesAllDraftFieldsUnchanged()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await LockRowAsync(database);

        var failure = await Assert.ThrowsAsync<PostgresException>(async () =>
            await new ProjectSaveWriter(database).TryStageAsync(
                Snapshot(original), original.Revision, MutationId, 1, Document(2, "Mismatched schema"), Digest));

        await Assert.That(failure!.SqlState).IsEqualTo(PostgresErrorCodes.CheckViolation);
        await Assert.That(failure.ConstraintName).IsEqualTo("CK_projects_document");
        await transaction.RollbackAsync();
        await AssertSameAsync(await ReadAsync(fixture), original);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task SaveWriter_RequiresCallerReadCommittedTransaction(bool wrongIsolation)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = wrongIsolation
            ? await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead) : null;

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await new ProjectSaveWriter(database).TryStageAsync(
                Snapshot(original), original.Revision, MutationId, 2, Document(2, "Rejected"), Digest));

        await AssertSameAsync(await ReadAsync(fixture), original);
    }

    [Test]
    [Arguments("stale")]
    [Arguments("replay")]
    [Arguments("exhausted")]
    public async Task SaveWriter_NonWritePolicyDecisionLeavesStoredStateUnchanged(string scenario)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture, scenario == "exhausted" ? Project.MaxRevision : 4,
            latestMutation: scenario == "replay");
        var expectedRevision = scenario == "exhausted" ? original.Revision : original.Revision - 1;
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await LockRowAsync(database);

        var staged = await new ProjectSaveWriter(database).TryStageAsync(
            Snapshot(original), expectedRevision, MutationId, 2, Document(2, "Not written"), Digest);

        await Assert.That(staged).IsFalse();
        await transaction.CommitAsync();
        await AssertSameAsync(await ReadAsync(fixture), original);
    }

    [Test]
    [Arguments("missing")]
    [Arguments("revision")]
    [Arguments("archived")]
    [Arguments("organization")]
    public async Task SaveWriter_ConditionalPredicateRejectsChangedRowsWithoutUpsert(string scenario)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        var snapshot = Snapshot(original);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        if (scenario == "archived")
        {
            await database.Database.ExecuteSqlInterpolatedAsync($"UPDATE projects SET archived = TRUE WHERE id = {ProjectId}");
            original = await ReadAsync(fixture);
        }
        snapshot = scenario switch
        {
            "missing" => snapshot with { ProjectId = Guid.NewGuid() },
            "revision" => snapshot with { Revision = snapshot.Revision - 1 },
            "organization" => snapshot with { OrganizationId = Guid.NewGuid() },
            _ => snapshot,
        };
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);

        var staged = await new ProjectSaveWriter(database).TryStageAsync(
            snapshot, snapshot.Revision, MutationId, 2, Document(2, "Not written"), Digest);

        await Assert.That(staged).IsFalse();
        await transaction.CommitAsync();
        await AssertSameAsync(await ReadAsync(fixture), original);
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task SaveWriter_CompetingRevisionWaitsThenRespectsCommitOrRollback(bool commitFirst)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        await using var firstScope = fixture.Services.CreateAsyncScope();
        await using var secondScope = fixture.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var second = secondScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var firstTransaction = await first.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await using var secondTransaction = await second.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        var firstBody = Document(2, "First");
        var secondBody = Document(2, "Second");
        var secondId = Guid.NewGuid();
        var secondDigest = Enumerable.Repeat((byte)84, 32).ToArray();
        await Assert.That(await new ProjectSaveWriter(first).TryStageAsync(
            Snapshot(original), original.Revision, MutationId, 2, firstBody, Digest)).IsTrue();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var contender = new ProjectSaveWriter(second).TryStageAsync(
            Snapshot(original), original.Revision, secondId, 2, secondBody, secondDigest, timeout.Token);
        var firstFinished = false;
        try
        {
            await WaitBlockedAsync(fixture, second, first, timeout.Token);
            if (commitFirst)
            {
                await firstTransaction.CommitAsync();
            }
            else
            {
                await firstTransaction.RollbackAsync();
            }
            firstFinished = true;
            await Assert.That(await contender).IsEqualTo(!commitFirst);
            await secondTransaction.CommitAsync();
        }
        finally
        {
            await timeout.CancelAsync();
            if (!firstFinished)
            {
                await firstTransaction.RollbackAsync();
            }
            try { await contender; }
            catch (OperationCanceledException) { }
        }

        var stored = await ReadAsync(fixture);
        await Assert.That(stored.Revision).IsEqualTo(original.Revision + 1);
        await Assert.That(stored.LastMutationActorId).IsEqualTo((Guid?)ActorId);
        await Assert.That(stored.LastMutationId).IsEqualTo((Guid?)(commitFirst ? MutationId : secondId));
        await Assert.That(stored.LastMutationDigest!.SequenceEqual(commitFirst ? Digest : secondDigest)).IsTrue();
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(stored.DocumentJson),
            JsonNode.Parse(commitFirst ? firstBody : secondBody))).IsTrue();
    }

    [Test]
    public async Task SaveWriter_CancellationDuringDatabaseWaitPreservesDraft()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var original = await SeedAsync(fixture);
        await using var blockerScope = fixture.Services.CreateAsyncScope();
        await using var writerScope = fixture.Services.CreateAsyncScope();
        var blocker = blockerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var writer = writerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var blockerTransaction = await blocker.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await using var writerTransaction = await writer.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await LockRowAsync(blocker);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var pending = new ProjectSaveWriter(writer).TryStageAsync(
            Snapshot(original), original.Revision, MutationId, 2, Document(2, "Canceled"), Digest, cancellation.Token);
        try
        {
            await WaitBlockedAsync(fixture, writer, blocker, cancellation.Token);
        }
        finally
        {
            await cancellation.CancelAsync();
            await Assert.ThrowsAsync<OperationCanceledException>(async () => await pending);
        }
        await writerTransaction.RollbackAsync();
        await blockerTransaction.RollbackAsync();
        await AssertSameAsync(await ReadAsync(fixture), original);
    }

    private static Task LockRowAsync(ApplicationDbContext database) =>
        database.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM projects WHERE id = {ProjectId} FOR UPDATE");

    private static async Task WaitBlockedAsync(PostgresAccountFixture fixture, ApplicationDbContext waiter,
        ApplicationDbContext blocker, CancellationToken cancellationToken)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var connection = (NpgsqlConnection)scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetDbConnection();
        await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("SELECT @blocker = ANY(pg_blocking_pids(@waiter))", connection);
        command.Parameters.AddWithValue("waiter", ((NpgsqlConnection)waiter.Database.GetDbConnection()).ProcessID);
        command.Parameters.AddWithValue("blocker", ((NpgsqlConnection)blocker.Database.GetDbConnection()).ProcessID);
        while (!(bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(10), cancellationToken);
        }
    }

    // These synthetic documents exercise storage, not SCRUM-50 authored-content acceptance
    private static string Document(int schemaVersion, string title) => JsonSerializer.Serialize(new
    {
        projectId = ProjectId,
        schemaVersion,
        title,
        scenes = new[] { new { id = "first", x = 1.5 }, new { id = "second", x = -2.0 } },
    });

    private static async Task<Project> SeedAsync(PostgresAccountFixture fixture, long revision = 4, bool latestMutation = false)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        database.Organizations.Add(new Organization { Id = OrganizationId, Name = "Storage test school" });
        database.Users.Add(new ApplicationUser { Id = ActorId, UserName = "writer", NormalizedUserName = "WRITER" });
        var project = new Project
        {
            Id = ProjectId,
            OrganizationId = OrganizationId,
            Revision = revision,
            SchemaVersion = 1,
            DocumentJson = Document(1, "Original"),
            UpdatedAt = DateTimeOffset.UnixEpoch,
            LastMutationActorId = latestMutation ? ActorId : null,
            LastMutationId = latestMutation ? MutationId : null,
            LastMutationDigest = latestMutation ? Digest.ToArray() : null,
        };
        database.Projects.Add(project);
        database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = ProjectId, UserId = ActorId, CanEdit = true });
        await database.SaveChangesAsync();
        return project;
    }

    private static ProjectAccessSnapshot Snapshot(Project project) => new(
        ActorId, project.Id, project.OrganizationId, project.IsArchived, project.Revision, project.SchemaVersion,
        project.DocumentJson, project.UpdatedAt, project.LastMutationActorId, project.LastMutationId,
        project.LastMutationDigest is { } digest ? ImmutableArray.CreateRange(digest) : null,
        CanEdit: !project.IsArchived, CanManage: false, CanPublish: false);

    private static async Task<Project> ReadAsync(PostgresAccountFixture fixture)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.AsNoTracking().SingleAsync();
    }

    private static async Task AssertSameAsync(Project actual, Project expected)
    {
        await Assert.That(actual.Id).IsEqualTo(expected.Id);
        await Assert.That(actual.OrganizationId).IsEqualTo(expected.OrganizationId);
        await Assert.That(actual.IsArchived).IsEqualTo(expected.IsArchived);
        await Assert.That(actual.Revision).IsEqualTo(expected.Revision);
        await Assert.That(actual.SchemaVersion).IsEqualTo(expected.SchemaVersion);
        await Assert.That(actual.UpdatedAt).IsEqualTo(expected.UpdatedAt);
        await Assert.That(actual.LastMutationActorId).IsEqualTo(expected.LastMutationActorId);
        await Assert.That(actual.LastMutationId).IsEqualTo(expected.LastMutationId);
        await Assert.That(actual.LastMutationDigest is null ? expected.LastMutationDigest is null
            : expected.LastMutationDigest is not null && actual.LastMutationDigest.SequenceEqual(expected.LastMutationDigest)).IsTrue();
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(actual.DocumentJson), JsonNode.Parse(expected.DocumentJson))).IsTrue();
    }
}
