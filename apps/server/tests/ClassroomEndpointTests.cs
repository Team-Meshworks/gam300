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

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ClassroomEndpointTests
{
    [Test]
    public async Task Classrooms_ManagersAndStudentsSeeOnlyAuthorizedClassesAndRoster()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var colleague = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var otherStudent = await fixture.CreateAccountAsync();
        var foreign = await fixture.CreateAccountAsync();
        var organization = await OrganizationAsync(fixture, educator);
        await MoveToOrganizationAsync(fixture, organization, colleague, student, otherStudent);
        await fixture.SignInAsync(educator);
        var id = await CreateAsync(fixture, "Studio", [colleague]);

        using (var added = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, student)))
        {
            await Assert.That(added.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        using (var eligible = await fixture.Client.GetAsync(ClassPath(id, "/eligible-students")))
        {
            await Assert.That(eligible.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var items = (await eligible.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().ToArray();
            await Assert.That(items.Select(item => item.GetProperty("userId").GetGuid()).ToHashSet().SetEquals([student, otherStudent])).IsTrue();
            await Assert.That(items.Single(item => item.GetProperty("userId").GetGuid() == student).GetProperty("enrolled").GetBoolean()).IsTrue();
            await Assert.That(items.Single(item => item.GetProperty("userId").GetGuid() == otherStudent).GetProperty("enrolled").GetBoolean()).IsFalse();
            await Assert.That(eligible.Headers.CacheControl?.NoStore).IsTrue();
        }
        using (var roster = await fixture.Client.GetAsync(ClassPath(id, "/roster")))
        {
            await Assert.That(roster.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var ids = (await roster.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray()
                .Select(item => item.GetProperty("userId").GetGuid()).ToHashSet();
            await Assert.That(ids.SetEquals([educator, colleague, student])).IsTrue();
        }

        using var studentClient = fixture.CreateClient();
        using var otherClient = fixture.CreateClient();
        using var foreignClient = fixture.CreateClient();
        using var anonymous = fixture.CreateClient();
        await fixture.SignInAsync(student, studentClient);
        await fixture.SignInAsync(otherStudent, otherClient);
        await fixture.SignInAsync(foreign, foreignClient, forgedRole: ApplicationRoles.Educator);
        using (var own = await studentClient.GetAsync(ClassPath(id))) { await Assert.That(own.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var privateRoster = await studentClient.GetAsync(ClassPath(id, "/roster"))) { await Assert.That(privateRoster.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var privateSelection = await studentClient.GetAsync(ClassPath(id, "/eligible-students"))) { await Assert.That(privateSelection.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var other = await otherClient.GetAsync(ClassPath(id))) { await Assert.That(other.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var forged = await foreignClient.GetAsync(ClassPath(id))) { await Assert.That(forged.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var noSession = await anonymous.GetAsync(ClassPath(id))) { await Assert.That(noSession.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized); }
        using var ownList = await studentClient.GetAsync("/api/v1/classes");
        var ownItems = (await ownList.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().ToArray();
        await Assert.That(ownItems.Length).IsEqualTo(1);
        await Assert.That(ownItems[0].GetProperty("id").GetGuid()).IsEqualTo(id);
    }

    [Test]
    public async Task Classrooms_RejectInvalidCrossOrganizationAndUnauthorizedWrites()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var foreignEducator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var foreignStudent = await fixture.CreateAccountAsync();
        var organization = await OrganizationAsync(fixture, educator);
        var foreignOrganization = await OrganizationAsync(fixture, foreignEducator);
        await MoveToOrganizationAsync(fixture, organization, student);
        await fixture.SignInAsync(educator);

        using (var invalid = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new { name = " ", managedByUserIds = Array.Empty<Guid>() }))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var crossOrg = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new { name = "Foreign", orgId = foreignOrganization }))
        { await Assert.That(crossOrg.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }
        using (var invalidManager = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new { name = "Foreign", managedByUserIds = new[] { foreignEducator } }))
        { await Assert.That(invalidManager.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity); }
        using (var duplicateManager = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new { name = "Duplicate", managedByUserIds = new[] { educator, educator } }))
        { await Assert.That(duplicateManager.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }

        var id = await CreateAsync(fixture, "Allowed", []);
        using (var foreignMember = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, foreignStudent)))
        { await Assert.That(foreignMember.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity); }
        using (var missingCsrf = await fixture.Client.PutAsync(MemberPath(id, student), null))
        { await Assert.That(missingCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var malformedPage = await fixture.Client.GetAsync("/api/v1/classes?limit=21"))
        { await Assert.That(malformedPage.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using var studentClient = fixture.CreateClient();
        await fixture.SignInAsync(student, studentClient);
        using (var create = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new { name = "Student class" }, studentClient))
        { await Assert.That(create.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }
        using (var add = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, student), studentClient))
        { await Assert.That(add.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Classrooms.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.ClassroomMembers.CountAsync()).IsEqualTo(1);
    }

    [Test]
    public async Task Classrooms_RemovalRetainsHistoryAndRevokesCurrentClassAccess()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var colleague = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        await MoveToOrganizationAsync(fixture, await OrganizationAsync(fixture, educator), colleague, student);
        await fixture.SignInAsync(educator);
        var id = await CreateAsync(fixture, "Studio", [colleague]);
        using (var add = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, student))) { await Assert.That(add.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using var studentClient = fixture.CreateClient();
        using var colleagueClient = fixture.CreateClient();
        await fixture.SignInAsync(student, studentClient);
        await fixture.SignInAsync(colleague, colleagueClient);

        using (var remove = await SendAsync(fixture, HttpMethod.Delete, MemberPath(id, student))) { await Assert.That(remove.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using (var removed = await studentClient.GetAsync(ClassPath(id))) { await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var retained = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ClassroomMembers.AsNoTracking()
                .SingleAsync(row => row.ClassroomId == id && row.UserId == student);
            await Assert.That(retained.IsActive).IsFalse();
        }
        using (var restore = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, student))) { await Assert.That(restore.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using (var restored = await studentClient.GetAsync(ClassPath(id))) { await Assert.That(restored.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var removeManager = await SendAsync(fixture, HttpMethod.Delete, MemberPath(id, colleague))) { await Assert.That(removeManager.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using (var revoked = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, colleague), colleagueClient))
        { await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
    }

    [Test]
    public async Task Classrooms_AdministratorUsesSelectedOrganizationAndInactiveAccountsAreIneligible()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var disabled = await fixture.CreateAccountAsync();
        var organization = await OrganizationAsync(fixture, educator);
        await MoveToOrganizationAsync(fixture, organization, student, disabled);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(row => row.Id == disabled)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        }
        await fixture.SignInAsync(administrator);
        using var created = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new
        {
            name = "Admin class",
            orgId = organization,
            managedByUserIds = new[] { educator },
        });
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        using (var invalid = await SendAsync(fixture, HttpMethod.Put, MemberPath(id, disabled)))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity); }
        using (var eligible = await fixture.Client.GetAsync(ClassPath(id, "/eligible-students")))
        {
            var ids = (await eligible.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray()
                .Select(item => item.GetProperty("userId").GetGuid()).ToArray();
            await Assert.That(ids.SequenceEqual([student])).IsTrue();
        }
        using var educatorClient = fixture.CreateClient();
        await fixture.SignInAsync(educator, educatorClient);
        using var managed = await educatorClient.GetAsync(ClassPath(id, "/roster"));
        await Assert.That(managed.StatusCode).IsEqualTo(HttpStatusCode.OK);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Classrooms_DatabaseRejectsCrossOrganizationAndWrongRoleMembership(bool wrongRole)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var organization = await OrganizationAsync(fixture, educator);
        if (wrongRole) { await MoveToOrganizationAsync(fixture, organization, student); }
        await fixture.SignInAsync(educator);
        var id = await CreateAsync(fixture, "Constraint test", []);

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ClassroomMembers.Add(new ClassroomMember
            {
                ClassroomId = id,
                OrganizationId = organization,
                UserId = student,
                RoleId = wrongRole ? ApplicationRoles.EducatorId : ApplicationRoles.CreatorId,
            });
            var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
            await Assert.That((error?.InnerException as PostgresException)?.SqlState).IsEqualTo(PostgresErrorCodes.ForeignKeyViolation);
        }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await verification.ServiceProvider.GetRequiredService<ApplicationDbContext>().ClassroomMembers
            .AnyAsync(row => row.ClassroomId == id && row.UserId == student)).IsFalse();
    }

    [Test]
    public async Task Classrooms_PaginationCannotRevealAnotherOrganization()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var foreign = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var organization = await OrganizationAsync(fixture, educator);
        var foreignOrganization = await OrganizationAsync(fixture, foreign);
        var ids = Enumerable.Range(1, 21).Select(value => Guid.Parse($"{value:x8}-0000-4000-8000-000000000000")).ToArray();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.Classrooms.AddRange(ids.Select(id => new Classroom { Id = id, OrganizationId = organization, Name = "Owned" }));
            database.ClassroomMembers.AddRange(ids.Select(id => new ClassroomMember
            {
                ClassroomId = id,
                OrganizationId = organization,
                UserId = educator,
                RoleId = ApplicationRoles.EducatorId,
            }));
            database.Classrooms.Add(new Classroom { Id = Guid.Parse("00000000-0000-4000-8000-000000000000"), OrganizationId = foreignOrganization, Name = "Foreign" });
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(educator);
        using var first = await fixture.Client.GetAsync("/api/v1/classes?limit=20");
        var firstPage = await first.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(firstPage.GetProperty("items").GetArrayLength()).IsEqualTo(20);
        var cursor = firstPage.GetProperty("nextCursor").GetGuid();
        using var second = await fixture.Client.GetAsync("/api/v1/classes?limit=20&cursor=" + cursor.ToString("D"));
        var secondPage = await second.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(secondPage.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(secondPage.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        var found = firstPage.GetProperty("items").EnumerateArray().Concat(secondPage.GetProperty("items").EnumerateArray())
            .Select(item => item.GetProperty("id").GetGuid()).ToHashSet();
        await Assert.That(found.SetEquals(ids)).IsTrue();
    }

    [Test]
    public async Task Classrooms_WaitingRosterWriteRechecksManagerAuthorityAfterLock()
    {
        var probe = new ClassLockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)), environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var colleague = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        await MoveToOrganizationAsync(fixture, await OrganizationAsync(fixture, educator), colleague, student);
        await fixture.SignInAsync(educator);
        var id = await CreateAsync(fixture, "Studio", [colleague]);
        using var colleagueClient = fixture.CreateClient();
        await fixture.SignInAsync(colleague, colleagueClient);

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync();
        await database.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM classrooms WHERE id = {id} FOR UPDATE");
        var blocker = ((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID;
        probe.Arm();
        var waiting = SendAsync(fixture, HttpMethod.Put, MemberPath(id, student), colleagueClient);
        var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await WaitBlockedAsync(fixture, waiter, blocker);
        await database.ClassroomMembers.Where(row => row.ClassroomId == id && row.UserId == colleague)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        await transaction.CommitAsync();
        using var response = await waiting;
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await Assert.That(await database.ClassroomMembers.AnyAsync(row => row.ClassroomId == id && row.UserId == student)).IsFalse();
    }

    private static async Task<Guid> CreateAsync(HttpsApplicationFixture fixture, string name, Guid[] managers)
    {
        using var response = await AuthTestRequests.PostAsync(fixture, "/api/v1/classes", new { name, managedByUserIds = managers });
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<Guid> OrganizationAsync(HttpsApplicationFixture fixture, Guid userId)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().OrganizationMemberships
            .Where(row => row.UserId == userId).Select(row => row.OrganizationId).SingleAsync();
    }

    private static async Task MoveToOrganizationAsync(HttpsApplicationFixture fixture, Guid organizationId, params Guid[] userIds)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await database.OrganizationMemberships.Where(row => userIds.Contains(row.UserId))
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organizationId));
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpsApplicationFixture fixture, HttpMethod method, string path,
        HttpClient? client = null)
    {
        client ??= fixture.Client;
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync(client));
        return await client.SendAsync(request);
    }

    private static string ClassPath(Guid id, string suffix = "") => "/api/v1/classes/" + id.ToString("D") + suffix;
    private static string MemberPath(Guid id, Guid userId) => ClassPath(id, "/members/" + userId.ToString("D"));

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
