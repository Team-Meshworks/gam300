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
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ClassAssignmentCoordinatorTests
{
    [Test]
    public async Task AssignmentCoordinator_CreatesIndependentDraftsAndReconcilesIdenticalRetries()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var request = Request(data);
        using var created = await SendAsync(fixture, data.ClassroomId, request);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var first = await created.Content.ReadFromJsonAsync<JsonElement>();
        var projects = first.GetProperty("projects").EnumerateArray().ToDictionary(
            row => row.GetProperty("studentId").GetGuid(), row => row.GetProperty("projectId").GetGuid());
        await Assert.That(projects.Count).IsEqualTo(2);
        await Assert.That(projects[data.FirstStudent]).IsNotEqualTo(projects[data.SecondStudent]);
        await Assert.That(projects.Values.Contains(data.SourceProject)).IsFalse();

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var assignment = await database.ClassAssignments.AsNoTracking().SingleAsync();
            await Assert.That(assignment.DueAtUnixSeconds).IsEqualTo(request.DueAtUnixSeconds!.Value);
            await Assert.That(assignment.Description).IsEqualTo(request.Description);
            await Assert.That(assignment.Instructions).IsEqualTo(request.Instructions);
            await Assert.That(await database.ClassAssignmentStudents.CountAsync()).IsEqualTo(2);
            await Assert.That(await database.ProjectProvenances.CountAsync(row => row.Kind == ProjectProvenance.Class)).IsEqualTo(2);
            var source = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == data.SourceProject);
            using var sourceJson = JsonDocument.Parse(source.DocumentJson);
            foreach (var (student, projectId) in projects)
            {
                var project = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId);
                using var json = JsonDocument.Parse(project.DocumentJson);
                await Assert.That(JsonElement.DeepEquals(json.RootElement.GetProperty("scenes"), sourceJson.RootElement.GetProperty("scenes"))).IsTrue();
                var ownGrant = await database.ProjectAssignments.SingleAsync(row => row.ProjectId == projectId && row.UserId == student);
                await Assert.That(ownGrant.CanEdit && !ownGrant.CanManage && !ownGrant.CanPublish).IsTrue();
                await Assert.That(await database.ProjectAssignments.AnyAsync(row => row.ProjectId == projectId
                    && row.UserId == data.Educator && row.CanManage)).IsTrue();
            }
            await database.Projects.Where(row => row.Id == data.SourceProject)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 1));
        }

        using var replay = await SendAsync(fixture, data.ClassroomId, request with { StudentIds = request.StudentIds!.Reverse().ToArray() });
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var replayed = (await replay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects").EnumerateArray()
            .ToDictionary(row => row.GetProperty("studentId").GetGuid(), row => row.GetProperty("projectId").GetGuid());
        await Assert.That(replayed.Count == projects.Count && projects.All(row => replayed[row.Key] == row.Value)).IsTrue();
        using var changed = await SendAsync(fixture, data.ClassroomId, request with { Title = "Changed intent" });
        await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        using var studentClient = fixture.CreateClient();
        await fixture.SignInAsync(data.FirstStudent, studentClient);
        using (var own = await studentClient.GetAsync("/api/projects/" + projects[data.FirstStudent].ToString("D")))
        { await Assert.That(own.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var other = await studentClient.GetAsync("/api/projects/" + projects[data.SecondStudent].ToString("D")))
        { await Assert.That(other.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using var updatedDocument = JsonDocument.Parse(ProjectTestDocuments.Create(projects[data.FirstStudent], "Changed student draft"));
        using var save = new HttpRequestMessage(HttpMethod.Put, "/api/projects/" + projects[data.FirstStudent].ToString("D"))
        {
            Content = JsonContent.Create(new { expectedRevision = 0, clientMutationId = Guid.NewGuid(), document = updatedDocument.RootElement }),
        };
        save.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync(studentClient));
        using (var saved = await studentClient.SendAsync(save)) { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var reopened = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.Projects.CountAsync()).IsEqualTo(3);
        var unchanged = await reopened.Projects.AsNoTracking().SingleAsync(row => row.Id == projects[data.SecondStudent]);
        using var unchangedJson = JsonDocument.Parse(unchanged.DocumentJson);
        await Assert.That(unchangedJson.RootElement.GetProperty("title").GetString()).IsEqualTo(request.Title);
    }

    [Test]
    public async Task AssignmentCoordinator_SecondDraftFailureRollsBackAndRetryDoesNotDuplicate()
    {
        var failure = new DraftInsertFailure();
        await using var fixture = await CreateFixtureAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)));
        var data = await SeedAsync(fixture);
        var request = Request(data);
        failure.Arm();
        using (var rejected = await SendAsync(fixture, data.ClassroomId, request))
        { await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable); }
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.ClassAssignments.AnyAsync()).IsFalse();
            await Assert.That(await database.ClassAssignmentStudents.AnyAsync()).IsFalse();
            await Assert.That(await database.ProjectProvenances.AnyAsync()).IsFalse();
            await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
        }
        using (var retry = await SendAsync(fixture, data.ClassroomId, request))
        { await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var replay = await SendAsync(fixture, data.ClassroomId, request))
        { await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var reopened = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.ClassAssignmentStudents.CountAsync()).IsEqualTo(2);
        await Assert.That(await reopened.Projects.CountAsync()).IsEqualTo(3);
    }

    [Test]
    public async Task AssignmentCoordinator_RejectsIneligibleStudentsAndStaleSourceWithoutPartialWrites()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var request = Request(data);
        using (var ineligible = await SendAsync(fixture, data.ClassroomId, request with { StudentIds = [data.FirstStudent, data.ForeignStudent] }))
        { await Assert.That(ineligible.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity); }
        using (var notEnrolled = await SendAsync(fixture, data.ClassroomId, request with { StudentIds = [data.FirstStudent, data.NotEnrolled] }))
        { await Assert.That(notEnrolled.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity); }
        using (var stale = await SendAsync(fixture, data.ClassroomId, request with { SourceRevision = 1 }))
        { await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        using var studentClient = fixture.CreateClient();
        await fixture.SignInAsync(data.FirstStudent, studentClient);
        using (var unauthorized = await SendAsync(fixture, data.ClassroomId, request, studentClient))
        { await Assert.That(unauthorized.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.ClassAssignments.AnyAsync()).IsFalse();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
    }

    [Test]
    public async Task AssignmentCoordinator_ConcurrentSameRequestReturnsOneCommittedBatch()
    {
        var pause = new CommitPause();
        var probe = new ClassLockProbe();
        await using var fixture = await CreateFixtureAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause, probe)));
        var data = await SeedAsync(fixture);
        var request = Request(data);
        var token = await fixture.GetCsrfAsync();
        pause.Armed = true;
        var first = SendAsync(fixture, data.ClassroomId, request, token: token);
        Task<HttpResponseMessage>? second = null;
        try
        {
            var blocker = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            probe.Arm();
            second = SendAsync(fixture, data.ClassroomId, request, token: token);
            var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, blocker);
            pause.Release.TrySetResult();
            using var winner = await first;
            using var replay = await second;
            await Assert.That(winner.StatusCode).IsEqualTo(HttpStatusCode.Created);
            await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var firstBody = await winner.Content.ReadFromJsonAsync<JsonElement>();
            var secondBody = await replay.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(JsonElement.DeepEquals(firstBody, secondBody)).IsTrue();
        }
        finally
        {
            pause.Release.TrySetResult();
            if (second is not null && !second.IsCompleted) { await second; }
            if (!first.IsCompleted) { await first; }
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.ClassAssignments.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.ClassAssignmentStudents.CountAsync()).IsEqualTo(2);
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(3);
    }

    [Test]
    public async Task AssignmentCoordinator_WaitingRequestRechecksTheRosterAfterClassLock()
    {
        var probe = new ClassLockProbe();
        await using var fixture = await CreateFixtureAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)));
        var data = await SeedAsync(fixture);
        var request = Request(data);
        var token = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync();
        await database.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM classrooms WHERE id = {data.ClassroomId} FOR UPDATE");
        var blocker = ((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID;
        probe.Arm();
        var waiting = SendAsync(fixture, data.ClassroomId, request, token: token);
        var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await WaitBlockedAsync(fixture, waiter, blocker);
        await database.ClassroomMembers.Where(row => row.ClassroomId == data.ClassroomId && row.UserId == data.SecondStudent)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        await transaction.CommitAsync();
        using var rejected = await waiting;
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        await Assert.That(await database.ClassAssignments.AnyAsync()).IsFalse();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
    }

    private static Task<HttpsApplicationFixture> CreateFixtureAsync(Action<WebApplicationBuilder>? configure = null) =>
        HttpsApplicationFixture.CreateAsync(configure, app => app.MapPost("/_test/class-assignments/{id:guid}",
            (Guid id, ClassAssignmentRequest request, HttpContext context, ApplicationDbContext database,
                ProjectAccessService access, ProjectDocumentService documents, CancellationToken cancellationToken) =>
                ClassAssignmentCoordinator.CreateAsync(id, request, context, database, access, documents, cancellationToken))
            .RequireAuthorization(SecurityPolicies.FullAccount), environmentName: "Development");

    private static async Task<Seeded> SeedAsync(HttpsApplicationFixture fixture)
    {
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var first = await fixture.CreateAccountAsync();
        var second = await fixture.CreateAccountAsync();
        var notEnrolled = await fixture.CreateAccountAsync();
        var foreign = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await database.OrganizationMemberships.Where(row => row.UserId == educator)
            .Select(row => row.OrganizationId).SingleAsync();
        await database.OrganizationMemberships.Where(row => row.UserId == first || row.UserId == second || row.UserId == notEnrolled)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
        var classroom = Guid.NewGuid();
        var source = Guid.NewGuid();
        database.Classrooms.Add(new Classroom { Id = classroom, OrganizationId = organization, Name = "Studio" });
        database.ClassroomMembers.AddRange(
            new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
            new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = first, RoleId = ApplicationRoles.CreatorId },
            new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = second, RoleId = ApplicationRoles.CreatorId });
        database.Projects.Add(new Project
        {
            Id = source,
            OrganizationId = organization,
            SchemaVersion = 1,
            DocumentJson = ProjectTestDocuments.Create(source, "Template"),
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = source, UserId = educator, CanEdit = true, CanManage = true, CanPublish = true });
        await database.SaveChangesAsync();
        await fixture.SignInAsync(educator);
        return new(classroom, source, educator, first, second, notEnrolled, foreign);
    }

    private static ClassAssignmentRequest Request(Seeded data) => new(Guid.NewGuid(), data.SourceProject, 0, 2_000_000_000,
        "Assignment", "Description", "Instructions", [data.FirstStudent, data.SecondStudent]);

    private static async Task<HttpResponseMessage> SendAsync(HttpsApplicationFixture fixture, Guid id, ClassAssignmentRequest request,
        HttpClient? client = null, string? token = null)
    {
        client ??= fixture.Client;
        using var message = new HttpRequestMessage(HttpMethod.Post, "/_test/class-assignments/" + id.ToString("D"))
        {
            Content = JsonContent.Create(request),
        };
        message.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(message);
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

    private sealed record Seeded(Guid ClassroomId, Guid SourceProject, Guid Educator, Guid FirstStudent, Guid SecondStudent,
        Guid NotEnrolled, Guid ForeignStudent);

    private sealed class DraftInsertFailure : DbCommandInterceptor
    {
        private int _remaining;
        public void Arm() => Interlocked.Exchange(ref _remaining, 2);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("INSERT INTO projects", StringComparison.Ordinal)
                && Volatile.Read(ref _remaining) > 0 && Interlocked.Decrement(ref _remaining) == 0)
            {
                throw new NpgsqlException("Synthetic second draft failure");
            }
            return ValueTask.FromResult(result);
        }
    }

    private sealed class CommitPause : DbTransactionInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed)
            {
                Armed = false;
                Entered.TrySetResult(((NpgsqlConnection)transaction.Connection!).ProcessID);
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }

    private sealed class ClassLockProbe : DbCommandInterceptor
    {
        private int _armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("classrooms", StringComparison.Ordinal)
                && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }
}
