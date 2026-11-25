using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

public sealed partial class ReceiptMigrationRollbackTests
{
    private const string Receipts = "20261114135210_AddCreationReceipts";
    private const string Generations = "20261114150108_AddCreationGenerations";
    private const string LegacyBindings = "20261114170716_AddLegacyCreationBindings";
    private const string ProjectsPath = "/api/v1/projects";

    [Test]
    [Arguments(Receipts, Removal)]
    [Arguments(Generations, Receipts)]
    public async Task ConcurrentFirstCreationReceiptSurvivesDowngrade(string current, string previous)
    {
        await using var fixture = await PostgresAccountFixture.CreateMigratedAsync(current);
        await using var migrationScope = fixture.Services.CreateAsyncScope();
        var db = migrationScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var writeScope = fixture.Services.CreateAsyncScope();
        var writer = writeScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var actor = new ApplicationUser { Id = Guid.NewGuid(), UserName = "creation-rollback", NormalizedUserName = "CREATION-ROLLBACK" };
        writer.Users.Add(actor);
        await writer.SaveChangesAsync();

        var operation = Guid.NewGuid();
        var resource = Guid.NewGuid();
        var digest = new byte[32];
        var response = JsonSerializer.Serialize(new
        {
            projectId = resource
        });
        await using var transaction = await writer.Database.BeginTransactionAsync();

        if (current == Receipts)
        {
            await writer.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO creation_receipts (actor_id, operation_id, kind, request_digest, resource_id, response_json)
                VALUES ({actor.Id}, {operation}, 'project', {digest}, {resource}, {response})
                """);
        }
        else
        {
            await writer.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO creation_receipts (actor_id, operation_id, kind, request_digest, resource_id, response_json, purpose, acknowledged)
                VALUES ({actor.Id}, {operation}, 'project', {digest}, {resource}, {response}, 'assignment-source', TRUE)
                """);
        }

        await AssertConcurrentDowngradeRefusedAsync(db, current, previous, ((NpgsqlConnection)writer.Database.GetDbConnection()).ProcessID,
            () => transaction.CommitAsync());

        await db.Database.MigrateAsync();
        var receipt = await db.Set<CreationReceipt>().SingleAsync(row => row.ActorId == actor.Id && row.OperationId == operation);

        await Assert.That(receipt.ResourceId).IsEqualTo(resource);
        await Assert.That(receipt.RequestDigest.SequenceEqual(digest)).IsTrue();
        await Assert.That(receipt.ResponseJson).IsEqualTo(response);
        await Assert.That(receipt.Purpose).IsEqualTo(current == Receipts ? "project" : "assignment-source");
        await Assert.That(receipt.Acknowledged).IsEqualTo(current == Generations);
    }

    [Test]
    public async Task ConcurrentAssignmentSourceCreationRemainsRecoverableFromAnotherProfileAfterRefusedDowngrade()
    {
        var gate = new ReceiptCommitGate();
        await using var app = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)), environmentName: "Development");
        var actor = await app.CreateAccountAsync(ApplicationRoles.Educator);
        await app.SignInAsync(actor);
        var csrf = await app.GetCsrfAsync();
        await using var scope = app.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await db.GetService<IMigrator>().MigrateAsync(Generations);
        var guard = new
        {
            purpose = "assignment-source",
            previousOperationId = (Guid?)null
        };
        var request = new
        {
            title = "Assignment source",
            operationId = Guid.NewGuid(),
            creationGuard = guard
        };
        gate.Armed = true;
        var creation = AuthTestRequests.PostAsync(app, ProjectsPath, request, token: csrf);
        await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        await AssertConcurrentDowngradeRefusedAsync(db, Generations, Receipts, gate.ProcessId, gate.AllowCommitAsync);
        using var created = await creation;

        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);

        var project = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();

        await db.Database.MigrateAsync();
        using var fresh = app.CreateClient();
        await app.SignInAsync(actor, fresh);
        using var head = await fresh.GetAsync("/api/v1/creation-operations/assignment-source");

        await Assert.That(head.StatusCode).IsEqualTo(HttpStatusCode.OK);

        var state = await head.Content.ReadFromJsonAsync<JsonElement>();

        await Assert.That(state.GetProperty("state").GetString()).IsEqualTo("unacknowledged");
        await Assert.That(state.GetProperty("operationId").GetGuid()).IsEqualTo(request.operationId);
        await Assert.That(state.GetProperty("receipt").GetProperty("projectId").GetGuid()).IsEqualTo(project);

        using var second = await AuthTestRequests.PostAsync(app, ProjectsPath, request with
        {
            operationId = Guid.NewGuid()
        }, fresh);
        await AuthTestRequests.AssertProblemAsync(second, HttpStatusCode.Conflict, "creation_state_changed");

        await Assert.That(await db.Projects.Select(row => row.Id).SingleAsync()).IsEqualTo(project);
    }

    [Test]
    public async Task ConcurrentLegacyDecisionStillReplaysTheOriginalProjectAfterRefusedDowngrade()
    {
        var gate = new ReceiptCommitGate();
        await using var app = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)), environmentName: "Development");
        await app.SignInAsync(await app.CreateAccountAsync(ApplicationRoles.Educator));
        var csrf = await app.GetCsrfAsync();
        await using var scope = app.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var body = new
        {
            title = "Legacy project"
        };
        gate.Armed = true;
        var creation = AuthTestRequests.PutAsync(app.Client, ProjectsPath + "/legacy-resolution?createAfter=initial", body, csrf);
        await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        await AssertConcurrentDowngradeRefusedAsync(db, LegacyBindings, Generations, gate.ProcessId, gate.AllowCommitAsync);
        using var created = await creation;

        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);

        using var replay = await AuthTestRequests.PostAsync(app, ProjectsPath, body, token: csrf);

        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(replay.Headers.GetValues("X-Spatia-Creation-Resolution").Single()).IsEqualTo("created");
        await Assert.That(replay.Headers.Location).IsEqualTo(created.Headers.Location);
        await Assert.That(await replay.Content.ReadAsStringAsync()).IsEqualTo(await created.Content.ReadAsStringAsync());
        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(1);
    }

    private static async Task AssertConcurrentDowngradeRefusedAsync(ApplicationDbContext db, string current, string previous,
        int writerPid, Func<Task> finishWrite)
    {
        await db.Database.OpenConnectionAsync();
        var migrationPid = ((NpgsqlConnection)db.Database.GetDbConnection()).ProcessID;
        var downgrade = db.GetService<IMigrator>().MigrateAsync(previous);

        try
        {
            await WaitForBlockAsync(db.Database.GetConnectionString()!, migrationPid, writerPid);
        }
        finally { await finishWrite(); }

        var refusal = await Assert.ThrowsAsync<PostgresException>(() => downgrade);

        await Assert.That(refusal!.SqlState).IsEqualTo(PostgresErrorCodes.RaiseException);
        await Assert.That((await db.Database.GetAppliedMigrationsAsync()).Last()).IsEqualTo(current);
    }
}
