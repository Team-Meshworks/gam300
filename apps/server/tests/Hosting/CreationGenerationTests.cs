using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(CreationGenerationTests))]
public sealed class CreationGenerationTests
{
    [Test]
    [Arguments("project")]
    [Arguments("class")]
    [Arguments("duplicate")]
    [Arguments("import")]
    [Arguments("assignment-source")]
    public async Task IndependentProfilesRecoverAndFenceDelayedOriginalsAfterAcknowledgement(string purpose)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var (source, document) = await SourceAsync(fixture, purpose);
        using var second = fixture.CreateClient();
        await fixture.SignInAsync(actor, second);
        await AssertStateAsync(await HeadAsync(fixture, purpose), null, "ready");
        await AssertStateAsync(await HeadAsync(fixture, purpose, second), null, "ready");
        var operations = new[] { Guid.NewGuid(), Guid.NewGuid() };
        var bodies = operations.Select(operation => Body(purpose, operation, null, document)).ToArray();
        var responses = await Task.WhenAll(
            AuthTestRequests.PostAsync(fixture, CreatePath(purpose, source), bodies[0]),
            AuthTestRequests.PostAsync(fixture, CreatePath(purpose, source), bodies[1], second));
        using var first = responses[0];
        using var other = responses[1];
        var winner = Array.FindIndex(responses, response => response.StatusCode == HttpStatusCode.Created);

        await Assert.That(winner).IsGreaterThanOrEqualTo(0);

        var loser = 1 - winner;
        await AuthTestRequests.AssertProblemAsync(responses[loser], HttpStatusCode.Conflict, "creation_state_changed");
        var original = await responses[winner].Content.ReadFromJsonAsync<JsonElement>();
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);
        var recovered = await HeadAsync(reopened, purpose);
        await AssertStateAsync(recovered, operations[winner], "unacknowledged");

        await Assert.That(recovered.GetProperty("receipt").GetRawText()).IsEqualTo(original.GetRawText());

        await AcknowledgeAsync(reopened, purpose, operations[winner]);
        await AssertStateAsync(await HeadAsync(reopened, purpose), operations[winner], "ready");
        using var late = await AuthTestRequests.PostAsync(reopened, CreatePath(purpose, source), bodies[loser]);
        await AuthTestRequests.AssertProblemAsync(late, HttpStatusCode.Conflict, "creation_state_changed");
        var next = Guid.NewGuid();
        using var distinct = await AuthTestRequests.PostAsync(reopened, CreatePath(purpose, source), Body(purpose, next, operations[winner], document));

        await Assert.That(distinct.StatusCode).IsEqualTo(HttpStatusCode.Created);

        using var retry = await AuthTestRequests.PostAsync(reopened, CreatePath(purpose, source), bodies[winner]);

        await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await retry.Content.ReadFromJsonAsync<JsonElement>()).GetRawText()).IsEqualTo(original.GetRawText());

        await AcknowledgeAsync(reopened, purpose, operations[winner]);
        await AssertStateAsync(await HeadAsync(reopened, purpose), next, "unacknowledged");
        await AcknowledgeAsync(reopened, purpose, next);
        await AssertStateAsync(await HeadAsync(reopened, purpose), next, "ready");
        await using var scope = fixture.Database.Services.CreateAsyncScope();

        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Set<CreationReceipt>()
            .CountAsync(row => row.ActorId == actor && row.Purpose == purpose)).IsEqualTo(2);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task LostCommitResponseAndFailedCommitHaveDiscoverableUnambiguousOutcomes(bool afterCommit)
    {
        var failure = new CommitFailure(afterCommit);
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var operation = Guid.NewGuid();
        var body = Body("project", operation, null);
        failure.Armed = true;
        using var uncertain = await AuthTestRequests.PostAsync(fixture, CreatePath("project"), body, token: token);

        await Assert.That(uncertain.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);

        using var fresh = fixture.CreateClient();
        await fixture.SignInAsync(actor, fresh);
        await AssertStateAsync(await HeadAsync(fixture, "project", fresh), afterCommit ? operation : null, afterCommit ? "unacknowledged" : "ready");
        using var retry = await AuthTestRequests.PostAsync(fixture, CreatePath("project"), body, fresh);

        await Assert.That(retry.StatusCode).IsEqualTo(afterCommit ? HttpStatusCode.OK : HttpStatusCode.Created);

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(1);
    }

    [Test]
    public async Task ExplicitlyKeyedUnguardedBurstsDrainEveryOutstandingReceiptBeforeLatestGenerationBecomesReady()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);

        for (var i = 0; i < 3; i++)
        {
            using var legacy = await AuthTestRequests.PostAsync(fixture, CreatePath("project"), new
            {
                title = "Explicit distinct",
                operationId = Guid.NewGuid()
            });

            await Assert.That(legacy.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var operations = await db.Set<CreationReceipt>().OrderByDescending(row => row.Sequence).Select(row => row.OperationId).ToArrayAsync();

        foreach (var operation in operations)
        {
            await AssertStateAsync(await HeadAsync(fixture, "project"), operation, "unacknowledged");
            await AcknowledgeAsync(fixture, "project", operation);
            using var blocked = await AuthTestRequests.PostAsync(fixture, CreatePath("project"), Body("project", Guid.NewGuid(), operation));

            await Assert.That(blocked.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        }

        await AssertStateAsync(await HeadAsync(fixture, "project"), operations[0], "ready");
        using var next = await AuthTestRequests.PostAsync(fixture, CreatePath("project"), Body("project", Guid.NewGuid(), operations[0]));

        await Assert.That(next.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(4);
    }

    [Test]
    [Arguments("project")]
    [Arguments("class")]
    [Arguments("duplicate")]
    public async Task UnavailableResourcesAndSourcesCanBeClosedWithoutRecreatingOrLeakingThem(string purpose)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var (source, _) = await SourceAsync(fixture, purpose);
        var operation = Guid.NewGuid();
        using var created = await AuthTestRequests.PostAsync(fixture, CreatePath(purpose, source), Body(purpose, operation, null));
        var resource = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty(purpose == "class" ? "id" : "projectId").GetGuid();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        if (purpose == "class")
        {
            await db.ClassroomMembers.Where(row => row.ClassroomId == resource).ExecuteDeleteAsync();
            await db.Classrooms.Where(row => row.Id == resource).ExecuteDeleteAsync();
        }
        else
        {
            await db.ProjectAssignments.Where(row => row.ProjectId == (purpose == "duplicate" ? source : resource)).ExecuteDeleteAsync();

            if (purpose == "project")
                await db.Projects.Where(row => row.Id == resource).ExecuteDeleteAsync();
        }

        var head = await HeadAsync(fixture, purpose);
        await AssertStateAsync(head, operation, "unacknowledged");

        await Assert.That(head.GetProperty("receipt").ValueKind).IsEqualTo(JsonValueKind.Null);

        var before = await db.Projects.CountAsync() + await db.Classrooms.CountAsync();
        await AcknowledgeAsync(fixture, purpose, operation);
        await AssertStateAsync(await HeadAsync(fixture, purpose), operation, "ready");

        await Assert.That(await db.Projects.CountAsync() + await db.Classrooms.CountAsync()).IsEqualTo(before);
    }

    [Test]
    public async Task ActorScopeAndAcknowledgementCannotCloseAnotherActorsOrNewerOperation()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var otherActor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var operation = Guid.NewGuid();
        using var first = await AuthTestRequests.PostAsync(fixture, CreatePath("class"), Body("class", operation, null));

        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.Created);

        await AssertStateAsync(await HeadAsync(fixture, "project"), null, "ready");
        using var other = fixture.CreateClient();
        await fixture.SignInAsync(otherActor, other);
        await AssertStateAsync(await HeadAsync(fixture, "class", other), null, "ready");
        using var foreignAck = await AuthTestRequests.PostAsync(fixture, AckPath("class", operation), new
        {
        }, other);

        await Assert.That(foreignAck.StatusCode).IsEqualTo(HttpStatusCode.NotFound);

        using var wrongScope = await AuthTestRequests.PostAsync(fixture, AckPath("project", operation), new
        {
        });

        await Assert.That(wrongScope.StatusCode).IsEqualTo(HttpStatusCode.NotFound);

        using var unprotected = await fixture.Client.PostAsJsonAsync(AckPath("class", operation), new
        {
        });

        await Assert.That(unprotected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);

        await AcknowledgeAsync(fixture, "class", operation);
        var next = Guid.NewGuid();
        var createNext = AuthTestRequests.PostAsync(fixture, CreatePath("class"), Body("class", next, operation));
        var oldAck = AuthTestRequests.PostAsync(fixture, AckPath("class", operation), new
        {
        });
        using var created = await createNext;
        using var acknowledged = await oldAck;

        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await Assert.That(acknowledged.StatusCode).IsEqualTo(HttpStatusCode.NoContent);

        await AssertStateAsync(await HeadAsync(fixture, "class"), next, "unacknowledged");
    }

    [Test]
    [Arguments("project")]
    [Arguments("class")]
    [Arguments("duplicate")]
    public async Task LegacyKeyedDigestIsUnchangedAndUnknownGuardedScopesAreRejected(string purpose)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, _) = await SourceAsync(fixture, purpose);
        var operationId = Guid.NewGuid();
        object request = purpose switch
        {
            "class" => new { name = "Legacy keyed", operationId },
            "duplicate" => new { title = "Legacy keyed", expectedRevision = 0, operationId },
            _ => new { title = "Legacy keyed", operationId },
        };
        using var created = await AuthTestRequests.PostAsync(fixture, CreatePath(purpose, source), request);

        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);

        object originalIntent = purpose switch
        {
            "class" => new { Name = "Legacy keyed", OrgId = (Guid?)null, ManagedByUserIds = (Guid[]?)null, OperationId = (Guid?)operationId },
            "duplicate" => new { id = source, request = new { OperationId = (Guid?)operationId, ExpectedRevision = 0L, Title = "Legacy keyed" } },
            _ => new
            {
                OperationId = (Guid?)operationId,
                Title = "Legacy keyed",
                Image = (ProjectImageUpload?)null,
                EnvironmentAssetId = (string?)null,
                Document = (JsonElement?)null,
                OrgId = (Guid?)null,
            },
        };
        var expected = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(originalIntent));
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        await Assert.That((await db.Set<CreationReceipt>().SingleAsync(row => row.OperationId == operationId)).RequestDigest.SequenceEqual(expected)).IsTrue();

        if (purpose == "duplicate")
        {
            await db.Set<CreationReceipt>().Where(row => row.OperationId == operationId).ExecuteUpdateAsync(set => set.SetProperty(row => row.SourceProjectId, (Guid?)null));
            var unknownSource = await HeadAsync(fixture, purpose);

            await Assert.That(unknownSource.GetProperty("receipt").ValueKind).IsEqualTo(JsonValueKind.Null);
        }

        using var replay = await AuthTestRequests.PostAsync(fixture, CreatePath(purpose, source), request);

        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);

        using var wrong = await AuthTestRequests.PostAsync(fixture, CreatePath("project"),
            new
            {
                title = "Wrong purpose",
                operationId = Guid.NewGuid(),
                creationGuard = new
                {
                    purpose = "class",
                    previousOperationId = (Guid?)null
                }
            });

        await Assert.That(wrong.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);

        using var missingRequest = new HttpRequestMessage(HttpMethod.Post, CreatePath("project"))
        {
            Content = JsonContent.Create(new { title = "Missing", creationGuard = new { purpose = "project", previousOperationId = (Guid?)null } })
        };
        missingRequest.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var missingKey = await fixture.Client.SendAsync(missingRequest);
        await AuthTestRequests.AssertProblemAsync(missingKey, HttpStatusCode.BadRequest, "creation_operation_id_required");
    }

    [Test]
    public async Task AdditiveMigrationPreservesLegacyReceiptsAndRefusesDestructiveDowngrades()
    {
        const string previous = "20261114135210_AddCreationReceipts";
        await using var fixture = await PostgresAccountFixture.CreateMigratedAsync(previous);
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var actor = new ApplicationUser { Id = Guid.NewGuid(), UserName = "generation-upgrade", NormalizedUserName = "GENERATION-UPGRADE" };
        db.Users.Add(actor);
        await db.SaveChangesAsync();
        var first = Guid.Parse("11111111-1111-4111-8111-111111111111");
        var second = Guid.Parse("22222222-2222-4222-8222-222222222222");
        var digest = new byte[32];
        var responseJson = "{}";

        foreach (var operation in new[] { second, first })
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO creation_receipts (actor_id, operation_id, kind, request_digest, resource_id, response_json)
                VALUES ({actor.Id}, {operation}, 'duplicate', {digest}, {Guid.NewGuid()}, {responseJson})
                """);
        }

        var migrator = db.GetService<IMigrator>();

        await Assert.ThrowsAsync<PostgresException>(() => migrator.MigrateAsync("20261114115659_AddAssetRemovalReceipts"));

        await PostgresAccountFixture.ExecuteMigrationScriptAsync(db,
            migrator.GenerateScript(previous, options: MigrationsSqlGenerationOptions.Idempotent));
        var receipts = await db.Set<CreationReceipt>().AsNoTracking().OrderBy(row => row.Sequence).ToArrayAsync();

        await Assert.That(receipts.Select(row => row.OperationId)).IsEquivalentTo(new[] { first, second });
        await Assert.That(receipts[0].OperationId).IsEqualTo(first);
        await Assert.That(receipts.All(row => row.Purpose == "duplicate" && !row.Acknowledged && row.SourceProjectId is null && row.RequestDigest.SequenceEqual(digest))).IsTrue();
        await Assert.ThrowsAsync<PostgresException>(() => migrator.MigrateAsync(previous));
        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(2);
        await Assert.That(db.Database.HasPendingModelChanges()).IsFalse();

        await db.Set<CreationReceipt>().ExecuteDeleteAsync();
        await migrator.MigrateAsync(previous);
        await migrator.MigrateAsync();

        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
        await Assert.That(db.Database.HasPendingModelChanges()).IsFalse();
    }

    private static async Task<(Guid Source, JsonElement? Document)> SourceAsync(HttpsApplicationFixture fixture, string purpose)
    {
        if (purpose is not ("duplicate" or "import"))
            return (Guid.Empty, null);

        using var created = await AuthTestRequests.PostAsync(fixture, CreatePath("project"), new
        {
            title = "Source",
            operationId = Guid.NewGuid()
        });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        using var opened = await fixture.Client.GetAsync($"/api/v1/projects/{id:D}");
        return (id, (await opened.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document").Clone());
    }

    private static object Body(string purpose, Guid operationId, Guid? previous, JsonElement? document = null) => purpose switch
    {
        "class" => new { name = "Same name", operationId, creationGuard = new { purpose, previousOperationId = previous } },
        "duplicate" => new { title = "Same name", expectedRevision = 0, operationId, creationGuard = new { purpose, previousOperationId = previous } },
        _ => new { title = "Same name", operationId, document, creationGuard = new { purpose, previousOperationId = previous } },
    };

    private static string CreatePath(string purpose, Guid source = default) => purpose switch
    {
        "class" => "/api/v1/classes",
        "duplicate" => $"/api/v1/projects/{source:D}/duplicate",
        _ => "/api/v1/projects",
    };

    private static string AckPath(string purpose, Guid operation) => $"/api/v1/creation-operations/{purpose}/{operation:D}/acknowledge";

    private static async Task<JsonElement> HeadAsync(HttpsApplicationFixture fixture, string purpose, HttpClient? client = null)
    {
        using var response = await (client ?? fixture.Client).GetAsync($"/api/v1/creation-operations/{purpose}");

        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();

        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task AcknowledgeAsync(HttpsApplicationFixture fixture, string purpose, Guid operation)
    {
        using var response = await AuthTestRequests.PostAsync(fixture, AckPath(purpose, operation), new
        {
        });

        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
    }

    private static async Task AssertStateAsync(JsonElement head, Guid? operation, string state)
    {
        await Assert.That(head.GetProperty("state").GetString()).IsEqualTo(state);
        await Assert.That(head.GetProperty("operationId").ValueKind == JsonValueKind.Null ? (Guid?)null : head.GetProperty("operationId").GetGuid()).IsEqualTo(operation);

        if (state == "ready")
            await Assert.That(head.GetProperty("receipt").ValueKind).IsEqualTo(JsonValueKind.Null);
    }

    private sealed class CommitFailure(bool afterCommit) : DbTransactionInterceptor
    {
        internal bool Armed
        {
            get; set;
        }

        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction, TransactionEventData eventData,
            InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed && !afterCommit)
            {
                Armed = false;
                throw new NpgsqlException("Synthetic generation rollback.");
            }

            return ValueTask.FromResult(result);
        }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (Armed && afterCommit)
            {
                Armed = false;
                throw new NpgsqlException("Synthetic lost generation response.");
            }

            return Task.CompletedTask;
        }
    }
}
