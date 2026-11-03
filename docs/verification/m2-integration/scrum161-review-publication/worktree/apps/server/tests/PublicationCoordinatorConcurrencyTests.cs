using System.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

public sealed partial class PublicationCoordinatorTests
{
    [Test]
    [Arguments("revision", false)]
    [Arguments("assignment", false)]
    [Arguments("publish", false)]
    [Arguments("archive", false)]
    [Arguments("disabled", false)]
    [Arguments("membership", false)]
    [Arguments("organization", false)]
    [Arguments("role", false)]
    [Arguments("stamp", false)]
    [Arguments("forced", false)]
    [Arguments("expired", false)]
    [Arguments("assignment", true)]
    [Arguments("publish", true)]
    [Arguments("archive", true)]
    [Arguments("stamp", true)]
    [Arguments("expired", true)]
    public async Task PublicationCoordinator_RechecksAuthorityAndRevisionAfterProjectLockWait(string change, bool replay)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        if (replay) { await fixture.PublishAsync(request); }
        await using var holder = fixture.Database();
        await using var transaction = await holder.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await holder.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM projects WHERE id = {fixture.ProjectId} FOR UPDATE");
        await using var waiter = fixture.Database();
        await waiter.Database.OpenConnectionAsync();
        var waiting = fixture.Coordinator(waiter).PublishAsync(fixture.Context(), fixture.ProjectId, request);
        try
        {
            await fixture.WaitBlockedAsync(Pid(waiter), Pid(holder));
            await ChangeAuthorityAsync(fixture, holder, change);
            await transaction.CommitAsync();
            var result = await waiting;
            await AssertNoAcknowledgementAsync(result);
            if (change == "revision") { await AssertRejectedAsync(result, PublicationRejection.RevisionConflict, 1); }
            else { await Assert.That(result.AccessFailure).IsEqualTo((ProjectAccessFailure?)ExpectedFailure(change)); }
        }
        finally
        {
            await transaction.DisposeAsync();
            await waiting;
        }
        await Assert.That(waiter.Database.CurrentTransaction).IsNull();
        await fixture.AssertCountAsync(replay ? 1 : 0);
    }

    [Test]
    [Arguments("disabled")]
    [Arguments("organization")]
    [Arguments("role")]
    [Arguments("stamp")]
    [Arguments("forced")]
    [Arguments("expired")]
    public async Task PublicationCoordinator_RechecksAccountAfterSlowPreparation(string change)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var gate = new Gate();
        fixture.Integration.BeforePrepare = _ => gate.WaitAsync();
        var pending = fixture.PublishAsync(Request());
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await using var updater = fixture.Database();
            await ChangeAuthorityAsync(fixture, updater, change);
            gate.Release.TrySetResult();
            var result = await pending;
            await AssertNoAcknowledgementAsync(result);
            await Assert.That(result.AccessFailure).IsEqualTo((ProjectAccessFailure?)ExpectedFailure(change));
        }
        finally { gate.Release.TrySetResult(); await pending; }
        await fixture.AssertCountAsync(0);
    }

    [Test]
    [Arguments("identical")]
    [Arguments("changed-intent")]
    [Arguments("different-id")]
    public async Task PublicationCoordinator_SameProjectConcurrentPublishesWaitForCommit(string scenario)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        var second = scenario switch
        {
            "different-id" => Request(),
            "changed-intent" => Request(id: request.PublicationId, intent: "{}"),
            _ => request,
        };
        var gate = new Gate();
        var commit = new PublicationCommitProbe { Before = (_, _) => gate.WaitAsync() };
        await using var firstDb = fixture.Database(commit);
        await using var secondDb = fixture.Database();
        var firstTask = fixture.Coordinator(firstDb).PublishAsync(fixture.Context(), fixture.ProjectId, request);
        Task<PublicationResult>? secondTask = null;
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await fixture.AssertCountAsync(0);
            await Assert.That(firstTask.IsCompleted).IsFalse();
            await secondDb.Database.OpenConnectionAsync();
            secondTask = fixture.Coordinator(secondDb).PublishAsync(fixture.Context(), fixture.ProjectId, second);
            await fixture.WaitBlockedAsync(Pid(secondDb), Pid(firstDb));
            gate.Release.TrySetResult();
            var first = await firstTask;
            await AssertCommittedAsync(first, request, fixture.ProjectId, false);
            var other = await secondTask;
            if (scenario == "changed-intent") { await AssertRejectedAsync(other, PublicationRejection.IdConflict); }
            else
            {
                await AssertCommittedAsync(other, second, fixture.ProjectId, scenario == "identical");
                if (scenario == "identical") { await Assert.That(other.Acknowledgement).IsEqualTo(first.Acknowledgement); }
            }
        }
        finally
        {
            gate.Release.TrySetResult();
            await firstTask;
            if (secondTask is not null) { await secondTask; }
        }
        await fixture.AssertCountAsync(scenario == "different-id" ? 2 : 1);
        await Assert.That(fixture.Integration.Stages).IsEqualTo(scenario == "different-id" ? 2 : 1);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationCoordinator_GlobalIdClaimWaitsAcrossDifferentProjects(bool firstRollsBack)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        await using var setup = fixture.Database();
        var otherProject = await AddProjectAsync(fixture, setup);
        var request = Request();
        var gate = new Gate();
        var commit = new PublicationCommitProbe
        {
            Before = async (_, _) =>
            {
                await gate.WaitAsync();
                if (firstRollsBack) { throw new InvalidOperationException("fixture rollback before commit"); }
            },
        };
        await using var firstDb = fixture.Database(commit);
        await using var secondDb = fixture.Database();
        var firstTask = fixture.Coordinator(firstDb).PublishAsync(fixture.Context(), fixture.ProjectId, request);
        Task<PublicationResult>? secondTask = null;
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await secondDb.Database.OpenConnectionAsync();
            secondTask = fixture.Coordinator(secondDb).PublishAsync(fixture.Context(), otherProject, request);
            await fixture.WaitBlockedAsync(Pid(secondDb), Pid(firstDb));
            await Assert.That(fixture.Integration.Preparations).IsEqualTo(2);
            await Assert.That(fixture.Integration.Stages).IsEqualTo(1);
            await fixture.AssertCountAsync(0);
            gate.Release.TrySetResult();
            if (firstRollsBack)
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => firstTask);
                await AssertCommittedAsync(await secondTask, request, otherProject, false);
            }
            else
            {
                await AssertCommittedAsync(await firstTask, request, fixture.ProjectId, false);
                await AssertRejectedAsync(await secondTask, PublicationRejection.IdConflict);
            }
        }
        finally
        {
            gate.Release.TrySetResult();
            try { await firstTask; } catch (InvalidOperationException) when (firstRollsBack) { }
            if (secondTask is not null) { await secondTask; }
        }
        await Assert.That(firstDb.Database.CurrentTransaction).IsNull();
        await Assert.That(secondDb.Database.CurrentTransaction).IsNull();
        await fixture.AssertCountAsync(1);
        await Assert.That((await fixture.ReadAsync(request.PublicationId)).ProjectId)
            .IsEqualTo(firstRollsBack ? otherProject : fixture.ProjectId);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationCoordinator_SavesAndPublishesUseOneProjectSerializationOrder(bool saveFirst)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        var envelope = new ParsedSaveEnvelope(0, Guid.NewGuid(), ProjectTestDocuments.Create(fixture.ProjectId, "Saved later"));
        var gate = new Gate();
        var commit = new PublicationCommitProbe { Before = (_, _) => gate.WaitAsync() };
        await using var saveDb = fixture.Database(saveFirst ? [commit] : []);
        await using var publishDb = fixture.Database(saveFirst ? [] : [commit]);
        var saver = new ProjectSaveService(saveDb, fixture.Access(saveDb), fixture.Documents);
        Task<ProjectSaveResult>? save = null;
        Task<PublicationResult>? publish = null;
        try
        {
            if (saveFirst) { save = saver.SaveAsync(fixture.Context(), fixture.ProjectId, envelope); }
            else { publish = fixture.Coordinator(publishDb).PublishAsync(fixture.Context(), fixture.ProjectId, request); }
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            if (saveFirst)
            {
                await publishDb.Database.OpenConnectionAsync();
                publish = fixture.Coordinator(publishDb).PublishAsync(fixture.Context(), fixture.ProjectId, request);
                await fixture.WaitBlockedAsync(Pid(publishDb), Pid(saveDb));
            }
            else
            {
                await saveDb.Database.OpenConnectionAsync();
                save = saver.SaveAsync(fixture.Context(), fixture.ProjectId, envelope);
                await fixture.WaitBlockedAsync(Pid(saveDb), Pid(publishDb));
            }
            gate.Release.TrySetResult();
            await Assert.That((await save!).Acknowledgement!.Revision).IsEqualTo(1);
            if (saveFirst) { await AssertRejectedAsync(await publish!, PublicationRejection.RevisionConflict, 1); }
            else
            {
                await AssertCommittedAsync(await publish!, request, fixture.ProjectId, false);
                await Assert.That((await fixture.ReadAsync(request.PublicationId)).DocumentJson.Contains("Chosen edition")).IsTrue();
            }
        }
        finally
        {
            gate.Release.TrySetResult();
            if (save is not null) { await save; }
            if (publish is not null) { await publish; }
        }
        await fixture.AssertCountAsync(saveFirst ? 0 : 1);
    }

    private static int Pid(ApplicationDbContext database) => ((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID;

    private static async Task ChangeAuthorityAsync(PublicationCoordinatorFixture fixture, ApplicationDbContext database, string change)
    {
        switch (change)
        {
            case "revision":
                var project = await database.Projects.SingleAsync();
                project.Revision++;
                project.DocumentJson = ProjectTestDocuments.Create(fixture.ProjectId, "Revisioned metadata");
                break;
            case "assignment": database.ProjectAssignments.Remove(await database.ProjectAssignments.SingleAsync()); break;
            case "publish": (await database.ProjectAssignments.SingleAsync()).CanPublish = false; break;
            case "archive": (await database.Projects.SingleAsync()).IsArchived = true; break;
            case "disabled": (await database.Users.SingleAsync()).IsActive = false; break;
            case "membership": database.OrganizationMemberships.Remove(await database.OrganizationMemberships.SingleAsync()); break;
            case "organization": (await database.Organizations.SingleAsync()).IsActive = false; break;
            case "role": (await database.Roles.SingleAsync(role => role.Id == ApplicationRoles.CreatorId)).Name = "ChangedRole"; break;
            case "stamp": (await database.Users.SingleAsync()).SecurityStamp = "changed"; break;
            case "forced": (await database.Users.SingleAsync()).MustChangePassword = true; break;
            case "expired": fixture.Clock.Advance(TimeSpan.FromHours(2)); break;
            default: throw new ArgumentOutOfRangeException(nameof(change));
        }
        await database.SaveChangesAsync();
    }

    private static ProjectAccessFailure ExpectedFailure(string change) => change switch
    {
        "assignment" => ProjectAccessFailure.NotFound,
        "publish" => ProjectAccessFailure.OperationForbidden,
        "archive" => ProjectAccessFailure.ProjectReadOnly,
        "forced" => ProjectAccessFailure.PasswordChangeRequired,
        _ => ProjectAccessFailure.AuthenticationRequired,
    };

    private sealed class Gate
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task WaitAsync()
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
    }
}
