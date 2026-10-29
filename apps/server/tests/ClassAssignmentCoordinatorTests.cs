using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

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
    public async Task AssignmentCoordinator_ProductionRequestBoundaryRejectsInvalidBodiesAndMissingCsrf()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var request = Request(data);
        var path = $"/api/classes/{data.ClassroomId:D}/assignments";
        using (var noCsrf = await fixture.Client.PostAsJsonAsync(path, request))
        { await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        var token = await fixture.GetCsrfAsync();
        var json = JsonSerializer.Serialize(request, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var stringDeadline = json.Replace("\"dueAtUnixSeconds\":2000000000", "\"dueAtUnixSeconds\":\"2000000000\"", StringComparison.Ordinal);
        await Assert.That(stringDeadline).IsNotEqualTo(json);
        using (var message = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(stringDeadline, System.Text.Encoding.UTF8, "application/json"),
        })
        {
            message.Headers.Add("X-CSRF-TOKEN", token);
            using var rejected = await fixture.Client.SendAsync(message);
            await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        using (var message = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(json.PadRight(17 * 1024), System.Text.Encoding.UTF8, "application/json"),
        })
        {
            message.Headers.Add("X-CSRF-TOKEN", token);
            using var rejected = await fixture.Client.SendAsync(message);
            await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.RequestEntityTooLarge);
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.ClassAssignments.AnyAsync()).IsFalse();
    }

    [Test]
    public async Task AssignmentReads_RespectClassMembershipAndExistingProjectGrants()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var request = Request(data);
        using var created = await SendAsync(fixture, data.ClassroomId, request);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var projects = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects").EnumerateArray()
            .ToDictionary(row => row.GetProperty("studentId").GetGuid(), row => row.GetProperty("projectId").GetGuid());
        var detailPath = $"/api/classes/{data.ClassroomId:D}/assignments/{request.RequestId:D}";
        using (var detail = await fixture.Client.GetAsync(detailPath))
        {
            await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(detail.Headers.CacheControl?.ToString()).IsEqualTo("no-store");
            var body = await detail.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(body.GetProperty("title").GetString()).IsEqualTo(request.Title);
            await Assert.That(body.GetProperty("description").GetString()).IsEqualTo(request.Description);
            await Assert.That(body.GetProperty("instructions").GetString()).IsEqualTo(request.Instructions);
            await Assert.That(body.GetProperty("dueAtUnixSeconds").GetInt64()).IsEqualTo(request.DueAtUnixSeconds!.Value);
            await Assert.That(body.GetProperty("projects").GetArrayLength()).IsEqualTo(2);
            await Assert.That(body.TryGetProperty("sourceProjectId", out _)).IsFalse();
            await Assert.That(body.TryGetProperty("requestDigest", out _)).IsFalse();
        }

        using var firstStudent = fixture.CreateClient();
        using var secondStudent = fixture.CreateClient();
        using var outsider = fixture.CreateClient();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ProjectAssignments.Add(new ProjectAssignment
            {
                ProjectId = projects[data.SecondStudent],
                UserId = data.FirstStudent,
                CanEdit = true,
            });
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(data.FirstStudent, firstStudent);
        await fixture.SignInAsync(data.SecondStudent, secondStudent);
        await fixture.SignInAsync(data.ForeignStudent, outsider);
        foreach (var (client, studentId) in new[] { (firstStudent, data.FirstStudent), (secondStudent, data.SecondStudent) })
        {
            using var detail = await client.GetAsync(detailPath);
            await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var entries = (await detail.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects").EnumerateArray().ToArray();
            await Assert.That(entries.Length).IsEqualTo(1);
            await Assert.That(entries[0].GetProperty("studentId").GetGuid()).IsEqualTo(studentId);
            await Assert.That(entries[0].GetProperty("projectId").GetGuid()).IsEqualTo(projects[studentId]);
            using var list = await client.GetAsync($"/api/classes/{data.ClassroomId:D}/assignments");
            var listed = (await list.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().ToArray();
            await Assert.That(listed.Length).IsEqualTo(1);
            await Assert.That(listed[0].GetProperty("projects").GetArrayLength()).IsEqualTo(1);
        }
        using (var denied = await outsider.GetAsync(detailPath))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using var administrator = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator), administrator);
        using (var detail = await administrator.GetAsync(detailPath))
        {
            await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await detail.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects").GetArrayLength()).IsEqualTo(2);
        }

        var newEducator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.Classrooms.Where(row => row.Id == data.ClassroomId)
                .Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == newEducator)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
        }
        using (var added = await ChangeMemberAsync(fixture, data.ClassroomId, newEducator, HttpMethod.Put))
        { await Assert.That(added.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using var addedEducator = fixture.CreateClient();
        await fixture.SignInAsync(newEducator, addedEducator);
        using (var denied = await addedEducator.GetAsync(detailPath))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var list = await addedEducator.GetAsync($"/api/classes/{data.ClassroomId:D}/assignments"))
        { await Assert.That((await list.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0); }

        using (var grant = new HttpRequestMessage(HttpMethod.Patch, $"/api/projects/{projects[data.FirstStudent]:D}/assignments")
        {
            Content = JsonContent.Create(new
            {
                expectedRevision = 0,
                managedByUserIds = new[] { data.Educator, newEducator },
                assignedCreatorIds = new[] { data.FirstStudent },
                canPublishUserIds = Array.Empty<Guid>(),
            }),
        })
        {
            grant.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var response = await fixture.Client.SendAsync(grant);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        }
        using (var detail = await addedEducator.GetAsync(detailPath))
        {
            await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var entries = (await detail.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects").EnumerateArray().ToArray();
            await Assert.That(entries.Length).IsEqualTo(1);
            await Assert.That(entries[0].GetProperty("studentId").GetGuid()).IsEqualTo(data.FirstStudent);
        }
        using (var removed = await ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Delete))
        { await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using (var denied = await firstStudent.GetAsync(detailPath))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var retained = await secondStudent.GetAsync(detailPath))
        { await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK); }
    }

    [Test]
    public async Task AssignmentReads_PaginateAndRejectUnauthorizedOrInvalidRequests()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var expected = new HashSet<Guid>();
        for (var index = 0; index < 3; index++)
        {
            var request = Request(data);
            using var response = await SendAsync(fixture, data.ClassroomId, request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
            expected.Add(request.RequestId!.Value);
        }
        var path = $"/api/classes/{data.ClassroomId:D}/assignments";
        var found = new HashSet<Guid>();
        string? cursor = null;
        do
        {
            using var response = await fixture.Client.GetAsync(path + "?limit=2" + (cursor is null ? "" : "&cursor=" + cursor));
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var page = await response.Content.ReadFromJsonAsync<JsonElement>();
            foreach (var item in page.GetProperty("items").EnumerateArray())
            { await Assert.That(found.Add(item.GetProperty("assignmentId").GetGuid())).IsTrue(); }
            cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
        } while (cursor is not null);
        await Assert.That(found.SetEquals(expected)).IsTrue();
        using (var invalid = await fixture.Client.GetAsync(path + "?limit=21"))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var invalid = await fixture.Client.GetAsync(path + "/" + expected.First().ToString("D") + "?cursor=unexpected"))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var missing = await fixture.Client.GetAsync(path + "/" + Guid.NewGuid().ToString("D")))
        { await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using var anonymous = fixture.CreateClient();
        using (var denied = await anonymous.GetAsync(path))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized); }
    }

    [Test]
    public async Task AssignmentReads_UnixSecondsPreserveInstantsAcrossOffsetsAndAdjacentSeconds()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var selected = new DateTimeOffset(2030, 5, 4, 21, 10, 30, TimeSpan.FromHours(8));
        foreach (var delta in new[] { -1, 0, 1 })
        {
            var local = selected.AddSeconds(delta);
            var request = Request(data) with { DueAtUnixSeconds = local.ToUnixTimeSeconds() };
            using (var created = await SendAsync(fixture, data.ClassroomId, request))
            { await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created); }
            using var response = await fixture.Client.GetAsync($"/api/classes/{data.ClassroomId:D}/assignments/{request.RequestId:D}");
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var timestamp = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("dueAtUnixSeconds").GetInt64();
            await Assert.That(timestamp).IsEqualTo(local.ToUnixTimeSeconds());
            var otherDevice = DateTimeOffset.FromUnixTimeSeconds(timestamp).ToOffset(TimeSpan.FromHours(-5));
            await Assert.That(otherDevice.DateTime).IsEqualTo(local.ToOffset(TimeSpan.FromHours(-5)).DateTime);
        }
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

    [Test]
    public async Task AssignmentAccess_RequiresCurrentClassMembershipButPreservesDraftsAndOtherProjects()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var projects = await CreateProjectsAsync(fixture, data);
        var anotherEducator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.Classrooms.Where(row => row.Id == data.ClassroomId)
                .Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == anotherEducator)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            database.ClassroomMembers.Add(new ClassroomMember
            {
                ClassroomId = data.ClassroomId,
                OrganizationId = organization,
                UserId = anotherEducator,
                RoleId = ApplicationRoles.EducatorId,
            });
            database.ProjectAssignments.AddRange(
                new ProjectAssignment { ProjectId = data.SourceProject, UserId = data.FirstStudent, CanEdit = true },
                new ProjectAssignment { ProjectId = projects[data.SecondStudent], UserId = data.FirstStudent, CanEdit = true },
                new ProjectAssignment { ProjectId = projects[data.FirstStudent], UserId = anotherEducator, CanEdit = true, CanManage = true },
                new ProjectAssignment { ProjectId = data.SourceProject, UserId = anotherEducator, CanEdit = true, CanManage = true });
            await database.SaveChangesAsync();
        }
        using var studentClient = fixture.CreateClient();
        using var educatorClient = fixture.CreateClient();
        await fixture.SignInAsync(data.FirstStudent, studentClient);
        await fixture.SignInAsync(anotherEducator, educatorClient);
        await AssertProjectStatusAsync(studentClient, projects[data.FirstStudent], HttpStatusCode.OK);
        await AssertProjectStatusAsync(studentClient, projects[data.SecondStudent], HttpStatusCode.NotFound);
        await AssertProjectStatusAsync(educatorClient, projects[data.FirstStudent], HttpStatusCode.OK);

        using (var removed = await ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Delete))
        { await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using (var removed = await ChangeMemberAsync(fixture, data.ClassroomId, anotherEducator, HttpMethod.Delete))
        { await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        await AssertProjectStatusAsync(studentClient, projects[data.FirstStudent], HttpStatusCode.NotFound);
        await AssertProjectStatusAsync(educatorClient, projects[data.FirstStudent], HttpStatusCode.NotFound);
        await AssertProjectStatusAsync(studentClient, data.SourceProject, HttpStatusCode.OK);
        await AssertProjectStatusAsync(educatorClient, data.SourceProject, HttpStatusCode.OK);
        using (var listed = await studentClient.GetAsync("/api/projects"))
        {
            var ids = (await listed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray()
                .Select(row => row.GetProperty("projectId").GetGuid()).ToArray();
            await Assert.That(ids.Contains(projects[data.FirstStudent])).IsFalse();
        }
        using (var save = await SaveDraftAsync(studentClient, projects[data.FirstStudent], "Denied", await fixture.GetCsrfAsync(studentClient)))
        { await Assert.That(save.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.Projects.AnyAsync(row => row.Id == projects[data.FirstStudent] && row.Revision == 0)).IsTrue();
            await Assert.That(await database.ProjectAssignments.AnyAsync(row => row.ProjectId == projects[data.FirstStudent]
                && row.UserId == data.FirstStudent && row.CanEdit)).IsTrue();
        }
        using (var restored = await ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Put))
        { await Assert.That(restored.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using (var restored = await ChangeMemberAsync(fixture, data.ClassroomId, anotherEducator, HttpMethod.Put))
        { await Assert.That(restored.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        await AssertProjectStatusAsync(studentClient, projects[data.FirstStudent], HttpStatusCode.OK);
        await AssertProjectStatusAsync(educatorClient, projects[data.FirstStudent], HttpStatusCode.OK);
    }

    [Test]
    public async Task AssignmentAccess_SaveAlreadyHoldingProjectLockIsPreservedBeforeRemoval()
    {
        var pause = new CommitPause();
        var probe = new ClassProjectLockProbe();
        await using var fixture = await CreateFixtureAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause, probe)));
        var data = await SeedAsync(fixture);
        var projects = await CreateProjectsAsync(fixture, data);
        using var student = fixture.CreateClient();
        await fixture.SignInAsync(data.FirstStudent, student);
        var studentToken = await fixture.GetCsrfAsync(student);
        var educatorToken = await fixture.GetCsrfAsync();
        pause.Armed = true;
        var saving = SaveDraftAsync(student, projects[data.FirstStudent], "Saved before removal", studentToken);
        Task<HttpResponseMessage>? removing = null;
        try
        {
            var blocker = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            probe.Arm();
            removing = ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Delete, educatorToken);
            var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, blocker);
            pause.Release.TrySetResult();
            using var saved = await saving;
            using var removed = await removing;
            await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        finally
        {
            pause.Release.TrySetResult();
            if (removing is not null && !removing.IsCompleted) { await removing; }
            if (!saving.IsCompleted) { await saving; }
        }
        await AssertProjectStatusAsync(student, projects[data.FirstStudent], HttpStatusCode.NotFound);
        await AssertStoredDraftAsync(fixture, projects[data.FirstStudent], "Saved before removal", 1);
    }

    [Test]
    public async Task AssignmentAccess_SaveWaitingForRemovalRechecksMembership()
    {
        var pause = new CommitPause();
        var probe = new ProjectLockProbe();
        await using var fixture = await CreateFixtureAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause, probe)));
        var data = await SeedAsync(fixture);
        var projects = await CreateProjectsAsync(fixture, data);
        using var student = fixture.CreateClient();
        await fixture.SignInAsync(data.FirstStudent, student);
        var studentToken = await fixture.GetCsrfAsync(student);
        var educatorToken = await fixture.GetCsrfAsync();
        pause.Armed = true;
        var removing = ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Delete, educatorToken);
        Task<HttpResponseMessage>? saving = null;
        try
        {
            var blocker = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            probe.Arm();
            saving = SaveDraftAsync(student, projects[data.FirstStudent], "Must not save", studentToken);
            var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, blocker);
            pause.Release.TrySetResult();
            using var removed = await removing;
            using var denied = await saving;
            await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }
        finally
        {
            pause.Release.TrySetResult();
            if (saving is not null && !saving.IsCompleted) { await saving; }
            if (!removing.IsCompleted) { await removing; }
        }
        await AssertStoredDraftAsync(fixture, projects[data.FirstStudent], "Assignment", 0);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task AssignmentAccess_ReassignmentAndRosterRemovalPreserveTheDraft(bool reassignFirst)
    {
        var pause = new CommitPause();
        var classProjectProbe = new ClassProjectLockProbe();
        var projectProbe = new ProjectLockProbe();
        await using var fixture = await CreateFixtureAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause, classProjectProbe, projectProbe)));
        var data = await SeedAsync(fixture);
        var projects = await CreateProjectsAsync(fixture, data);
        var token = await fixture.GetCsrfAsync();
        pause.Armed = true;
        var first = reassignFirst
            ? ReassignAsync(fixture, projects[data.FirstStudent], data.Educator, token)
            : ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Delete, token);
        Task<HttpResponseMessage>? second = null;
        try
        {
            var blocker = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (reassignFirst)
            {
                classProjectProbe.Arm();
                second = ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Delete, token);
            }
            else
            {
                projectProbe.Arm();
                second = ReassignAsync(fixture, projects[data.FirstStudent], data.Educator, token);
            }
            var waiter = await (reassignFirst ? classProjectProbe.Entered.Task : projectProbe.Entered.Task)
                .WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, blocker);
            pause.Release.TrySetResult();
            using var firstResult = await first;
            using var secondResult = await second;
            await Assert.That(firstResult.StatusCode).IsEqualTo(reassignFirst ? HttpStatusCode.OK : HttpStatusCode.NoContent);
            await Assert.That(secondResult.StatusCode).IsEqualTo(reassignFirst ? HttpStatusCode.NoContent : HttpStatusCode.OK);
        }
        finally
        {
            pause.Release.TrySetResult();
            if (second is not null && !second.IsCompleted) { await second; }
            if (!first.IsCompleted) { await first; }
        }
        await AssertStoredDraftAsync(fixture, projects[data.FirstStudent], "Assignment", 1);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.ClassAssignmentStudents.AnyAsync(row => row.StudentId == data.FirstStudent
                && row.ProjectId == projects[data.FirstStudent])).IsTrue();
            await Assert.That(await database.ProjectProvenances.AnyAsync(row => row.ProjectId == projects[data.FirstStudent]
                && row.Kind == ProjectProvenance.Class)).IsTrue();
            await Assert.That(await database.ProjectAssignments.AnyAsync(row => row.ProjectId == projects[data.FirstStudent]
                && row.UserId == data.FirstStudent)).IsFalse();
        }
        using (var restored = await ChangeMemberAsync(fixture, data.ClassroomId, data.FirstStudent, HttpMethod.Put))
        { await Assert.That(restored.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        using var student = fixture.CreateClient();
        await fixture.SignInAsync(data.FirstStudent, student);
        await AssertProjectStatusAsync(student, projects[data.FirstStudent], HttpStatusCode.NotFound);
    }

    [Test]
    public async Task AssignmentPersistence_ServerRestartRetainsRosterMetadataAndIndependentDrafts()
    {
        await using var fixture = await CreateFixtureAsync();
        var data = await SeedAsync(fixture);
        var projects = await CreateProjectsAsync(fixture, data);
        using (var student = fixture.CreateClient())
        {
            await fixture.SignInAsync(data.FirstStudent, student);
            using var saved = await SaveDraftAsync(student, projects[data.FirstStudent], "Saved before restart", await fixture.GetCsrfAsync(student));
            await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        }
        await fixture.App.StopAsync();
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(data.Educator);
        using (var classroom = await restarted.Client.GetAsync($"/api/classes/{data.ClassroomId:D}"))
        { await Assert.That(classroom.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        await AssertProjectStatusAsync(restarted.Client, projects[data.FirstStudent], HttpStatusCode.OK);
        await AssertStoredDraftAsync(restarted, projects[data.FirstStudent], "Saved before restart", 1);
        await AssertStoredDraftAsync(restarted, projects[data.SecondStudent], "Assignment", 0);
        await using var scope = restarted.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var assignment = await database.ClassAssignments.AsNoTracking().SingleAsync();
        await Assert.That(assignment.Title).IsEqualTo("Assignment");
        await Assert.That(assignment.Description).IsEqualTo("Description");
        await Assert.That(assignment.Instructions).IsEqualTo("Instructions");
        await Assert.That(assignment.DueAtUnixSeconds).IsEqualTo(2_000_000_000L);
        await Assert.That(await database.ClassAssignmentStudents.CountAsync()).IsEqualTo(2);
        await Assert.That(await database.ProjectProvenances.CountAsync(row => row.Kind == ProjectProvenance.Class)).IsEqualTo(2);
        using var detail = await restarted.Client.GetAsync($"/api/classes/{data.ClassroomId:D}/assignments/{assignment.Id:D}");
        await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await detail.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("dueAtUnixSeconds").GetInt64())
            .IsEqualTo(2_000_000_000L);
    }

    private static Task<HttpsApplicationFixture> CreateFixtureAsync(Action<WebApplicationBuilder>? configure = null) =>
        HttpsApplicationFixture.CreateAsync(configure, environmentName: "Development");

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

    private static async Task<Dictionary<Guid, Guid>> CreateProjectsAsync(HttpsApplicationFixture fixture, Seeded data)
    {
        using var created = await SendAsync(fixture, data.ClassroomId, Request(data));
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        return (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects").EnumerateArray()
            .ToDictionary(row => row.GetProperty("studentId").GetGuid(), row => row.GetProperty("projectId").GetGuid());
    }

    private static async Task<HttpResponseMessage> ChangeMemberAsync(HttpsApplicationFixture fixture, Guid classroomId,
        Guid userId, HttpMethod method, string? token = null)
    {
        using var message = new HttpRequestMessage(method, $"/api/classes/{classroomId:D}/members/{userId:D}");
        message.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(message);
    }

    private static async Task<HttpResponseMessage> SaveDraftAsync(HttpClient client, Guid projectId, string title, string token)
    {
        using var document = JsonDocument.Parse(ProjectTestDocuments.Create(projectId, title));
        using var message = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{projectId:D}")
        {
            Content = JsonContent.Create(new { expectedRevision = 0, clientMutationId = Guid.NewGuid(), document = document.RootElement }),
        };
        message.Headers.Add("X-CSRF-TOKEN", token);
        return await client.SendAsync(message);
    }

    private static async Task<HttpResponseMessage> ReassignAsync(HttpsApplicationFixture fixture, Guid projectId, Guid educator, string token)
    {
        using var message = new HttpRequestMessage(HttpMethod.Patch, $"/api/projects/{projectId:D}/assignments")
        {
            Content = JsonContent.Create(new
            {
                expectedRevision = 0,
                managedByUserIds = new[] { educator },
                assignedCreatorIds = Array.Empty<Guid>(),
                canPublishUserIds = Array.Empty<Guid>(),
            }),
        };
        message.Headers.Add("X-CSRF-TOKEN", token);
        return await fixture.Client.SendAsync(message);
    }

    private static async Task AssertProjectStatusAsync(HttpClient client, Guid projectId, HttpStatusCode expected)
    {
        using var response = await client.GetAsync($"/api/projects/{projectId:D}");
        await Assert.That(response.StatusCode).IsEqualTo(expected);
    }

    private static async Task AssertStoredDraftAsync(HttpsApplicationFixture fixture, Guid projectId, string title, long revision)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId);
        using var document = JsonDocument.Parse(project.DocumentJson);
        await Assert.That(project.Revision).IsEqualTo(revision);
        await Assert.That(document.RootElement.GetProperty("title").GetString()).IsEqualTo(title);
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpsApplicationFixture fixture, Guid id, ClassAssignmentRequest request,
        HttpClient? client = null, string? token = null)
    {
        client ??= fixture.Client;
        using var message = new HttpRequestMessage(HttpMethod.Post, "/api/classes/" + id.ToString("D") + "/assignments")
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

    private sealed class ClassProjectLockProbe : DbCommandInterceptor
    {
        private int _armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("class_assignment_students", StringComparison.Ordinal)
                && command.CommandText.Contains("FOR UPDATE OF p", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }

    private sealed class ProjectLockProbe : DbCommandInterceptor
    {
        private int _armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("FROM projects", StringComparison.Ordinal)
                && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }
}
