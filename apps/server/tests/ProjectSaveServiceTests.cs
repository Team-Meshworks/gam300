using System.Data;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectSaveServiceTests
{
    private const string BodyMarker = "private-save-body-not-for-denied-readers";

    [Test]
    public async Task SaveService_CommitReplayNewRevisionAndOlderRetryPreserveAuthoritativeState()
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        using var login = await AuthTestRequests.PostAsync(fixture, "/api/auth/login", new
        {
            userName = await AuthTestRequests.UserNameAsync(fixture, seeded.ActorId),
            password = AuthTestRequests.CurrentPassword,
        });
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        var request = CreateRequest(seeded.ProjectId);
        var first = await SaveAsync(fixture, seeded.ProjectId, request);
        var acknowledgement = await AssertCommittedAsync(first, seeded.ProjectId, request.ClientMutationId, 1);
        var stored = await ReadAsync(fixture, seeded.ProjectId);
        await Assert.That(acknowledgement.GetProperty("savedAt").GetDateTimeOffset()).IsEqualTo(stored.UpdatedAt);
        await Assert.That(stored.LastMutationActorId).IsEqualTo((Guid?)seeded.ActorId);
        await Assert.That(stored.LastMutationDigest!.SequenceEqual(request.RequestDigest)).IsTrue();

        var replay = await SaveAsync(fixture, seeded.ProjectId, request);
        await Assert.That(replay.GetProperty("acknowledgement").GetRawText()).IsEqualTo(acknowledgement.GetRawText());
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), stored);

        var next = request with { ExpectedRevision = 1, ClientMutationId = Guid.NewGuid() };
        await AssertCommittedAsync(await SaveAsync(fixture, seeded.ProjectId, next), seeded.ProjectId, next.ClientMutationId, 2);
        var latest = await ReadAsync(fixture, seeded.ProjectId);
        await Assert.That(latest.DocumentJson).IsEqualTo(stored.DocumentJson);
        await AssertRejectedAsync(await SaveAsync(fixture, seeded.ProjectId, request), ProjectSaveDecision.Conflict, 2);
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), latest);
    }

    [Test]
    [Arguments("digest")]
    [Arguments("actor")]
    [Arguments("original-revision")]
    public async Task SaveService_ChangedLatestMutationIdentityConflictsWithoutAnotherWrite(string change)
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = CreateRequest(seeded.ProjectId);
        await SaveAsync(fixture, seeded.ProjectId, request);
        var stored = await ReadAsync(fixture, seeded.ProjectId);
        HttpClient? client = null;
        if (change == "actor")
        {
            var otherId = await fixture.CreateAccountAsync();
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE organization_memberships SET organization_id = {stored.OrganizationId} WHERE user_id = {otherId}");
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = seeded.ProjectId, UserId = otherId, CanEdit = true });
            await database.SaveChangesAsync();
            client = fixture.CreateClient();
            await fixture.SignInAsync(otherId, client);
        }
        request = change switch
        {
            "digest" => request with { DocumentJson = Document(seeded.ProjectId, "Changed"), RequestDigest = new byte[32] },
            "original-revision" => request with { ExpectedRevision = 1 },
            _ => request,
        };

        await AssertRejectedAsync(await SaveAsync(fixture, seeded.ProjectId, request, client), ProjectSaveDecision.Conflict, 1);
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), stored);
    }

    [Test]
    [Arguments("anonymous", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("unassigned", ProjectAccessFailure.NotFound)]
    [Arguments("archived", ProjectAccessFailure.ProjectReadOnly)]
    public async Task SaveService_DeniedMatchingRetryDisclosesNoAcknowledgementOrRevision(
        string change, ProjectAccessFailure failure)
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = CreateRequest(seeded.ProjectId);
        await SaveAsync(fixture, seeded.ProjectId, request);
        HttpClient? client = null;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (change == "anonymous")
            {
                client = fixture.CreateClient();
            }
            else if (change == "unassigned")
            {
                database.ProjectAssignments.Remove(await database.ProjectAssignments.SingleAsync());
            }
            else
            {
                (await database.Projects.SingleAsync()).IsArchived = true;
            }
            await database.SaveChangesAsync();
        }
        var before = await ReadAsync(fixture, seeded.ProjectId);

        await AssertDeniedAsync(await SaveAsync(fixture, seeded.ProjectId, request, client), failure);
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), before);
    }

    [Test]
    public async Task SaveService_LockWaitRechecksAssignmentBeforeAcknowledgingMatchingRetry()
    {
        var armed = false;
        var waiter = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fixture = await CreateFixtureAsync(operation: async (context, database, access, id, request) =>
        {
            if (armed)
            {
                await database.Database.OpenConnectionAsync(context.RequestAborted);
                waiter.TrySetResult(((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID);
            }
            return await InvokeAsync(context, database, access, id, request, context.RequestAborted);
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = CreateRequest(seeded.ProjectId);
        await SaveAsync(fixture, seeded.ProjectId, request);
        var stored = await ReadAsync(fixture, seeded.ProjectId);
        var token = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var holder = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await holder.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await holder.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM projects WHERE id = {seeded.ProjectId} FOR UPDATE");
        armed = true;
        var responseTask = AuthTestRequests.PostAsync(fixture, Path(seeded.ProjectId), request, token: token);
        HttpResponseMessage? response = null;
        try
        {
            await WaitBlockedAsync(fixture, await waiter.Task.WaitAsync(TimeSpan.FromSeconds(10)),
                ((NpgsqlConnection)holder.Database.GetDbConnection()).ProcessID);
            (await holder.ProjectAssignments.SingleAsync()).CanEdit = false;
            await holder.SaveChangesAsync();
            await transaction.CommitAsync();
            response = await responseTask;
            await AssertDeniedAsync(await JsonAsync(response), ProjectAccessFailure.NotFound);
        }
        finally
        {
            await transaction.DisposeAsync();
            response ??= await responseTask;
            response.Dispose();
        }
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), stored);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task SaveService_ConcurrentRequestsWaitForCommitThenConflictOrReplay(bool identical)
    {
        var commit = new CommitProbe();
        var entered = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var waiter = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        await using var fixture = await CreateFixtureAsync(
            configure: builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit)),
            operation: async (context, database, access, id, request) =>
            {
                if (Interlocked.Increment(ref calls) == 2)
                {
                    await database.Database.OpenConnectionAsync(context.RequestAborted);
                    waiter.TrySetResult(((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID);
                }
                return await InvokeAsync(context, database, access, id, request, context.RequestAborted);
            });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = CreateRequest(seeded.ProjectId);
        var other = identical ? request : request with { ClientMutationId = Guid.NewGuid() };
        var token = await fixture.GetCsrfAsync();
        commit.Before = (transaction, cancellationToken) =>
        {
            entered.TrySetResult(((NpgsqlConnection)transaction.Connection!).ProcessID);
            return release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        };
        var firstTask = AuthTestRequests.PostAsync(fixture, Path(seeded.ProjectId), request, token: token);
        Task<HttpResponseMessage>? secondTask = null;
        HttpResponseMessage? firstResponse = null;
        HttpResponseMessage? secondResponse = null;
        try
        {
            var blocker = await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await Assert.That(firstTask.IsCompleted).IsFalse();
            await Assert.That((await ReadAsync(fixture, seeded.ProjectId)).Revision).IsEqualTo(0L);
            secondTask = AuthTestRequests.PostAsync(fixture, Path(seeded.ProjectId), other, token: token);
            await WaitBlockedAsync(fixture, await waiter.Task.WaitAsync(TimeSpan.FromSeconds(10)), blocker);
            release.TrySetResult();
            firstResponse = await firstTask;
            secondResponse = await secondTask;
            var first = await JsonAsync(firstResponse);
            var second = await JsonAsync(secondResponse);
            await AssertCommittedAsync(first, seeded.ProjectId, request.ClientMutationId, 1);
            if (identical)
            {
                await Assert.That(second.GetRawText()).IsEqualTo(first.GetRawText());
            }
            else
            {
                await AssertRejectedAsync(second, ProjectSaveDecision.Conflict, 1);
            }
        }
        finally
        {
            release.TrySetResult();
            firstResponse ??= await firstTask;
            firstResponse.Dispose();
            if (secondTask is not null)
            {
                secondResponse ??= await secondTask;
                secondResponse.Dispose();
            }
        }
        await Assert.That((await ReadAsync(fixture, seeded.ProjectId)).Revision).IsEqualTo(1L);
    }

    [Test]
    [Arguments("before-commit")]
    [Arguments("after-commit")]
    [Arguments("canceled-after-commit")]
    public async Task SaveService_UnconfirmedOutcomeReturnsNoAcknowledgementAndExactRetryReconciles(string stage)
    {
        var commit = new CommitProbe();
        using var cancellation = new CancellationTokenSource();
        var useCancellation = true;
        await using var fixture = await CreateFixtureAsync(
            configure: builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit)),
            operation: (context, database, access, id, request) => InvokeAsync(context, database, access, id, request,
                useCancellation ? cancellation.Token : context.RequestAborted));
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = CreateRequest(seeded.ProjectId);
        var original = await ReadAsync(fixture, seeded.ProjectId);
        if (stage == "before-commit")
        {
            commit.Before = (_, _) => throw new InvalidOperationException(HttpsApplicationFixture.SecretSentinel);
        }
        else
        {
            commit.After = stage == "after-commit"
                ? () => throw new InvalidOperationException(HttpsApplicationFixture.SecretSentinel)
                : () => cancellation.Cancel();
        }

        using var response = await AuthTestRequests.PostAsync(fixture, Path(seeded.ProjectId), request);
        await Assert.That(response.IsSuccessStatusCode).IsFalse();
        await Assert.That((await response.Content.ReadAsStringAsync()).Contains("acknowledgement", StringComparison.Ordinal)).IsFalse();
        await AuthTestRequests.AssertSafeAsync(fixture, response);
        var afterFailure = await ReadAsync(fixture, seeded.ProjectId);
        await Assert.That(afterFailure.Revision).IsEqualTo(stage == "before-commit" ? 0L : 1L);
        if (stage == "before-commit")
        {
            await AssertSameAsync(afterFailure, original);
        }

        useCancellation = false;
        await AssertCommittedAsync(await SaveAsync(fixture, seeded.ProjectId, request), seeded.ProjectId, request.ClientMutationId, 1);
        if (stage != "before-commit")
        {
            await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), afterFailure);
        }
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task SaveService_ExpiryAfterWriteOrCommitSuppressesAcknowledgement(bool afterCommit)
    {
        var commit = new CommitProbe();
        var write = new WriteProbe();
        await using var fixture = await CreateFixtureAsync(configure: builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, write)));
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = CreateRequest(seeded.ProjectId);
        var original = await ReadAsync(fixture, seeded.ProjectId);
        var cutoff = new DateTimeOffset(long.Parse(
            fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!,
            System.Globalization.CultureInfo.InvariantCulture), TimeSpan.Zero);
        if (afterCommit)
        {
            commit.After = () => fixture.Clock.Set(cutoff);
        }
        else
        {
            write.After = () => fixture.Clock.Set(cutoff);
        }

        await AssertDeniedAsync(await SaveAsync(fixture, seeded.ProjectId, request), ProjectAccessFailure.AuthenticationRequired);
        var stored = await ReadAsync(fixture, seeded.ProjectId);
        await Assert.That(stored.Revision).IsEqualTo(afterCommit ? 1L : 0L);
        if (!afterCommit)
        {
            await AssertSameAsync(stored, original);
        }
        await fixture.SignInAsync(seeded.ActorId);
        await AssertCommittedAsync(await SaveAsync(fixture, seeded.ProjectId, request), seeded.ProjectId, request.ClientMutationId, 1);
        if (afterCommit)
        {
            await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), stored);
        }
    }

    [Test]
    public async Task SaveService_ZeroRowUpdateNeverReturnsAcknowledgement()
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var original = await ReadAsync(fixture, seeded.ProjectId);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await database.Database.ExecuteSqlRawAsync("""
            CREATE FUNCTION suppress_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
            CREATE TRIGGER suppress_save BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION suppress_save();
            """);

        await AssertRejectedAsync(await SaveAsync(fixture, seeded.ProjectId, CreateRequest(seeded.ProjectId)),
            ProjectSaveDecision.Conflict, 0);
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), original);
    }

    [Test]
    public async Task SaveService_RevisionLimitReturnsAuthorizedExhaustionWithoutWrite()
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        (await database.Projects.SingleAsync()).Revision = Project.MaxRevision;
        await database.SaveChangesAsync();
        var original = await ReadAsync(fixture, seeded.ProjectId);
        var request = CreateRequest(seeded.ProjectId) with { ExpectedRevision = Project.MaxRevision };

        await AssertRejectedAsync(await SaveAsync(fixture, seeded.ProjectId, request),
            ProjectSaveDecision.RevisionExhausted, Project.MaxRevision);
        await AssertSameAsync(await ReadAsync(fixture, seeded.ProjectId), original);
    }

    [Test]
    public async Task SaveService_RejectsCallerTransactionWithoutDisposingIt()
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var access = scope.ServiceProvider.GetRequiredService<ProjectAccessService>();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        var request = CreateRequest(seeded.ProjectId);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await InvokeAsync(new DefaultHttpContext(), database, access, seeded.ProjectId, request, CancellationToken.None));

        await Assert.That(database.Database.CurrentTransaction).IsEqualTo(transaction);
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That((await ReadAsync(fixture, seeded.ProjectId)).Revision).IsEqualTo(0L);
    }

    private static Task<HttpsApplicationFixture> CreateFixtureAsync(Action<WebApplicationBuilder>? configure = null,
        Func<HttpContext, ApplicationDbContext, ProjectAccessService, Guid, ProbeRequest, Task<ProjectSaveResult>>? operation = null) =>
        HttpsApplicationFixture.CreateAsync(configure, app =>
            app.MapPost("/_test/project-save/{id:guid}", async (HttpContext context, Guid id, ProbeRequest request,
                ProjectAccessService access, ApplicationDbContext database) =>
            {
                var result = await (operation is null
                    ? InvokeAsync(context, database, access, id, request, context.RequestAborted)
                    : operation(context, database, access, id, request));
                return Results.Json(new
                {
                    result.Acknowledgement,
                    accessFailure = result.AccessFailure?.ToString(),
                    rejection = result.Rejection?.ToString(),
                    result.CurrentRevision,
                });
            }).AllowAnonymous());

    private static Task<ProjectSaveResult> InvokeAsync(HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, Guid id, ProbeRequest request, CancellationToken cancellationToken) =>
        new ProjectSaveService(database, access).SaveAsync(context, id, request.ToEnvelope(), request.SchemaVersion,
            request.RequestDigest, cancellationToken);

    // Synthetic documents/digests exercise transaction composition, not SCRUM-50 validation or hashing
    private sealed record ProbeRequest(long ExpectedRevision, Guid ClientMutationId, int SchemaVersion,
        string DocumentJson, byte[] RequestDigest)
    {
        public ParsedSaveEnvelope ToEnvelope() => new(ExpectedRevision, ClientMutationId, DocumentJson);
    }

    private static ProbeRequest CreateRequest(Guid id) =>
        new(0, Guid.NewGuid(), 1, Document(id, BodyMarker), Enumerable.Repeat((byte)42, 32).ToArray());

    private static string Document(Guid id, string title) => JsonSerializer.Serialize(new { projectId = id, schemaVersion = 1, title });

    private static string Path(Guid id) => "/_test/project-save/" + id.ToString("D");

    private static async Task<(Guid ActorId, Guid ProjectId)> SeedAsync(HttpsApplicationFixture fixture)
    {
        var actorId = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var id = Guid.NewGuid();
        database.Projects.Add(new Project
        {
            Id = id,
            OrganizationId = (await database.Organizations.SingleAsync()).Id,
            SchemaVersion = 1,
            DocumentJson = Document(id, "Original"),
            UpdatedAt = DateTimeOffset.UnixEpoch,
        });
        database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = actorId, CanEdit = true });
        await database.SaveChangesAsync();
        return (actorId, id);
    }

    private static async Task<JsonElement> SaveAsync(HttpsApplicationFixture fixture, Guid id, ProbeRequest request,
        HttpClient? client = null)
    {
        using var response = await AuthTestRequests.PostAsync(fixture, Path(id), request, client);
        return await JsonAsync(response);
    }

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task<JsonElement> AssertCommittedAsync(JsonElement result, Guid id, Guid mutationId, long revision)
    {
        await Assert.That(result.GetProperty("accessFailure").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetProperty("rejection").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetProperty("currentRevision").ValueKind).IsEqualTo(JsonValueKind.Null);
        var acknowledgement = result.GetProperty("acknowledgement");
        await Assert.That(acknowledgement.GetProperty("projectId").GetGuid()).IsEqualTo(id);
        await Assert.That(acknowledgement.GetProperty("clientMutationId").GetGuid()).IsEqualTo(mutationId);
        await Assert.That(acknowledgement.GetProperty("revision").GetInt64()).IsEqualTo(revision);
        await Assert.That(acknowledgement.GetProperty("savedAt").GetDateTimeOffset().Offset).IsEqualTo(TimeSpan.Zero);
        return acknowledgement;
    }

    private static async Task AssertDeniedAsync(JsonElement result, ProjectAccessFailure failure)
    {
        await Assert.That(result.GetProperty("accessFailure").GetString()).IsEqualTo(failure.ToString());
        await Assert.That(result.GetProperty("acknowledgement").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetProperty("rejection").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetProperty("currentRevision").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetRawText().Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    private static async Task AssertRejectedAsync(JsonElement result, ProjectSaveDecision decision, long revision)
    {
        await Assert.That(result.GetProperty("accessFailure").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetProperty("acknowledgement").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetProperty("rejection").GetString()).IsEqualTo(decision.ToString());
        await Assert.That(result.GetProperty("currentRevision").GetInt64()).IsEqualTo(revision);
        await Assert.That(result.GetRawText().Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    private static async Task<Project> ReadAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.AsNoTracking().SingleAsync(row => row.Id == id);
    }

    private static async Task AssertSameAsync(Project actual, Project expected)
    {
        await Assert.That(actual.DocumentJson).IsEqualTo(expected.DocumentJson);
        await Assert.That(actual.SchemaVersion).IsEqualTo(expected.SchemaVersion);
        await Assert.That(actual.Revision).IsEqualTo(expected.Revision);
        await Assert.That(actual.UpdatedAt).IsEqualTo(expected.UpdatedAt);
        await Assert.That(actual.LastMutationActorId).IsEqualTo(expected.LastMutationActorId);
        await Assert.That(actual.LastMutationId).IsEqualTo(expected.LastMutationId);
        await Assert.That(actual.LastMutationDigest is null ? expected.LastMutationDigest is null
            : expected.LastMutationDigest is not null && actual.LastMutationDigest.SequenceEqual(expected.LastMutationDigest)).IsTrue();
    }

    private static async Task WaitBlockedAsync(HttpsApplicationFixture fixture, int waiter, int blocker)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var connection = (NpgsqlConnection)scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetDbConnection();
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("SELECT @blocker = ANY(pg_blocking_pids(@waiter))", connection);
        command.Parameters.AddWithValue("waiter", waiter);
        command.Parameters.AddWithValue("blocker", blocker);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!(bool)(await command.ExecuteScalarAsync(timeout.Token) ?? false))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(10), timeout.Token);
        }
    }

    private sealed class CommitProbe : DbTransactionInterceptor
    {
        public Func<DbTransaction, CancellationToken, Task>? Before;
        public Action? After;

        public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Exchange(ref Before, null) is { } before)
            {
                await before(transaction, cancellationToken);
            }
            return result;
        }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return Task.CompletedTask;
        }
    }

    private sealed class WriteProbe : DbCommandInterceptor
    {
        public Action? After;

        public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
            int result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.StartsWith("UPDATE projects", StringComparison.Ordinal))
            {
                Interlocked.Exchange(ref After, null)?.Invoke();
            }
            return ValueTask.FromResult(result);
        }
    }
}
