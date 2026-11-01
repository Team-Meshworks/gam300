using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectReadEndpointTests
{
    private const string BodyMarker = "private-read-document-sentinel";

    [Test]
    public async Task Browser_ProjectListOpenAndAccountSwitchUseCurrentSession()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var first = await fixture.CreateAccountAsync();
        var second = await fixture.CreateAccountAsync();
        var firstProject = await SeedAsync(fixture, first);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE organization_memberships SET organization_id = {firstProject.OrganizationId} WHERE user_id = {second}");
        }
        var secondProject = await SeedAsync(fixture, second);
        var serverDirectory = System.IO.Path.GetFullPath("../../../../", AppContext.BaseDirectory);
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = serverDirectory,
        };
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        start.ArgumentList.Add(System.IO.Path.Combine(serverDirectory, "tests/project-read-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(JsonSerializer.Serialize(new[]
        {
            new { userName = await AuthTestRequests.UserNameAsync(fixture, first), projectId = firstProject.Id },
            new { userName = await AuthTestRequests.UserNameAsync(fixture, second), projectId = secondProject.Id },
        }));
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the project browser check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch
        {
            process.Kill(true);
            await process.WaitForExitAsync();
            throw;
        }
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException("Project browser check failed: " + await error);
        }
        var browserOutput = await output;
        await Assert.That(browserOutput.Contains("browser project list/open/session switch passed", StringComparison.Ordinal)).IsTrue();
        await Assert.That(string.IsNullOrWhiteSpace(await error)).IsTrue();
        await File.WriteAllTextAsync(System.IO.Path.Combine(serverDirectory, ".artifacts/scrum45-part7-browser-version.txt"), browserOutput);
    }

    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task ProjectReads_ReturnCompleteValidatedDocumentAndBoundedPublicSummary(int version)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync();
        var title = version == 1 ? new string('a', 254) + "🌏" + BodyMarker : BodyMarker;
        var project = await SeedAsync(fixture, actor, title: title, version: version, publish: true);
        await LoginAsync(fixture, actor, fixture.Client);

        var opened = await GetAsync(fixture.Client, Path(project.Id));
        await AssertFieldsAsync(opened, "projectId", "revision", "updatedAt", "document", "permissions");
        await Assert.That(opened.GetProperty("projectId").GetGuid()).IsEqualTo(project.Id);
        await Assert.That(opened.GetProperty("revision").GetInt64()).IsEqualTo(project.Revision);
        await Assert.That(opened.GetProperty("updatedAt").GetDateTimeOffset()).IsEqualTo(project.UpdatedAt);
        await using var documentScope = fixture.App.Services.CreateAsyncScope();
        var documents = documentScope.ServiceProvider.GetRequiredService<ProjectDocumentService>();
        using var expected = JsonDocument.Parse(documents.Serialize(documents.Read(project.Id, project.DocumentJson).Value!).Value!);
        await Assert.That(JsonElement.DeepEquals(opened.GetProperty("document"), expected.RootElement)).IsTrue();
        await AssertPermissionsAsync(opened, true, false, true);

        var page = await GetAsync(fixture.Client, "/api/projects");
        await AssertFieldsAsync(page, "items", "nextCursor");
        var summary = page.GetProperty("items").EnumerateArray().Single();
        await AssertFieldsAsync(summary, "projectId", "title", "revision", "updatedAt", "archived", "permissions");
        await Assert.That(summary.GetProperty("projectId").GetGuid()).IsEqualTo(project.Id);
        await Assert.That(summary.GetProperty("revision").GetInt64()).IsEqualTo(project.Revision);
        await Assert.That(summary.GetProperty("updatedAt").GetDateTimeOffset()).IsEqualTo(project.UpdatedAt);
        await Assert.That(summary.GetProperty("archived").GetBoolean()).IsFalse();
        await Assert.That(summary.GetProperty("title").GetString()).IsEqualTo(version == 1 ? new string('a', 254) + "…" : title);
        await AssertPermissionsAsync(summary, true, false, true);
        await Assert.That(page.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(fixture.Logs.Messages.Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    public async Task ProjectReads_TwoStudentsSeeOnlyTheirAssignmentsDespiteForgedClaimsAndCrossOrganizationAssignment()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var first = await fixture.CreateAccountAsync();
        var second = await fixture.CreateAccountAsync();
        var foreign = await fixture.CreateAccountAsync();
        var firstProject = await SeedAsync(fixture, first);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE organization_memberships SET organization_id = {firstProject.OrganizationId} WHERE user_id = {second}");
        }
        var secondProject = await SeedAsync(fixture, second);
        var foreignProject = await SeedAsync(fixture, foreign);
        var corrupt = await SeedAsync(fixture, second);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = foreignProject.Id, UserId = first, CanEdit = true });
            await database.ProjectAssignments.Where(row => row.ProjectId == corrupt.Id).ExecuteDeleteAsync();
            var invalid = JsonSerializer.Serialize(new { projectId = corrupt.Id, schemaVersion = 1, title = BodyMarker });
            await database.Projects.Where(row => row.Id == corrupt.Id)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.DocumentJson, invalid));
            await database.SaveChangesAsync();
        }
        var secondClient = fixture.CreateClient();
        await LoginAsync(fixture, first, fixture.Client);
        await LoginAsync(fixture, second, secondClient);
        foreach (var (client, own, other) in new[]
        {
            (fixture.Client, firstProject.Id, secondProject.Id), (secondClient, secondProject.Id, firstProject.Id),
        })
        {
            await AssertIdsAsync(await GetAsync(client, "/api/projects"), own);
            await Assert.That((await GetAsync(client, Path(own))).GetProperty("projectId").GetGuid()).IsEqualTo(own);
            using var denied = await client.GetAsync(Path(other));
            using var missing = await client.GetAsync(Path(Guid.NewGuid()));
            var deniedBody = await ProblemAsync(denied, HttpStatusCode.NotFound, "project_not_found");
            var missingBody = await ProblemAsync(missing, HttpStatusCode.NotFound, "project_not_found");
            foreach (var field in new[] { "type", "title", "status", "code" })
            {
                await Assert.That(deniedBody.GetProperty(field).GetRawText()).IsEqualTo(missingBody.GetProperty(field).GetRawText());
            }
        }
        await fixture.SignInAsync(first, forgedRole: ApplicationRoles.Administrator);
        await AssertIdsAsync(await GetAsync(fixture.Client, "/api/projects"), firstProject.Id);
        foreach (var id in new[] { secondProject.Id, foreignProject.Id, corrupt.Id })
        {
            using var denied = await fixture.Client.GetAsync(Path(id));
            await ProblemAsync(denied, HttpStatusCode.NotFound, "project_not_found");
        }
        await Assert.That(fixture.Logs.Messages.Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    [Arguments(ApplicationRoles.Educator)]
    [Arguments(ApplicationRoles.Administrator)]
    public async Task ProjectReads_ManagementAuthorityAndArchiveFilterDeterminePermissions(string role)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(role);
        var other = await fixture.CreateAccountAsync();
        var otherProject = await SeedAsync(fixture, other);
        var own = await SeedAsync(fixture, actor, manage: true,
            organization: role == ApplicationRoles.Administrator ? otherProject.OrganizationId : null);
        var archived = await SeedAsync(fixture, actor, manage: true, archived: true, organization: own.OrganizationId);
        await fixture.SignInAsync(actor);

        var expected = role == ApplicationRoles.Administrator ? new[] { own.Id, otherProject.Id } : [own.Id];
        await AssertIdsAsync(await GetAsync(fixture.Client, "/api/projects"), expected.Order().ToArray());
        await AssertPermissionsAsync(await GetAsync(fixture.Client, Path(own.Id)), true, true, true);
        var archivedPage = await GetAsync(fixture.Client, "/api/projects?archived=true");
        await AssertIdsAsync(archivedPage, archived.Id);
        var summary = archivedPage.GetProperty("items")[0];
        await Assert.That(summary.GetProperty("archived").GetBoolean()).IsTrue();
        await AssertPermissionsAsync(summary, false, true, false);
        await AssertPermissionsAsync(await GetAsync(fixture.Client, Path(archived.Id)), false, true, false);
        if (role == ApplicationRoles.Educator)
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectAssignments
                .Where(row => row.ProjectId == own.Id).ExecuteUpdateAsync(set => set.SetProperty(row => row.CanManage, false));
            using var revoked = await fixture.Client.GetAsync(Path(own.Id));
            await ProblemAsync(revoked, HttpStatusCode.NotFound, "project_not_found");
            await AssertIdsAsync(await GetAsync(fixture.Client, "/api/projects"));
        }
    }

    [Test]
    public async Task ProjectReads_PaginationIsBoundedAndCursorNeverGrantsAccess()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync();
        var other = await fixture.CreateAccountAsync();
        var ids = Enumerable.Range(0, 21).Select(index => Guid.Parse($"{index * 2 + 1:x8}-0000-4000-8000-000000000000")).ToArray();
        foreach (var id in ids)
        {
            await SeedAsync(fixture, actor, id: id);
        }
        var hidden = await SeedAsync(fixture, other, id: Guid.Parse("00000002-0000-4000-8000-000000000000"));
        await fixture.SignInAsync(actor);
        var defaultPage = await GetAsync(fixture.Client, "/api/projects");
        await AssertIdsAsync(defaultPage, ids.Take(10).ToArray());
        await Assert.That(defaultPage.GetProperty("nextCursor").GetGuid()).IsEqualTo(ids[9]);
        var firstPage = await GetAsync(fixture.Client, "/api/projects?limit=20&archived=false");
        await AssertIdsAsync(firstPage, ids.Take(20).ToArray());
        await Assert.That(firstPage.GetProperty("nextCursor").GetGuid()).IsEqualTo(ids[19]);
        var nextPath = "/api/projects?limit=20&cursor=" + firstPage.GetProperty("nextCursor").GetString();
        var secondPage = await GetAsync(fixture.Client, nextPath);
        await AssertIdsAsync(secondPage, ids[20]);
        await Assert.That(secondPage.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        await AssertIdsAsync(await GetAsync(fixture.Client, "/api/projects?limit=1&cursor=" + hidden.Id), ids[1]);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectAssignments
                .Where(row => row.ProjectId == ids[20]).ExecuteDeleteAsync();
        }
        await AssertIdsAsync(await GetAsync(fixture.Client, nextPath));
        foreach (var query in new[]
        {
            "limit=0", "limit=21", "limit=-1", "limit=1.5", "limit=", "limit=1&limit=2",
            "cursor=private-query-sentinel", "cursor=" + ids[0].ToString("N"),
            "cursor=" + ids[0] + "&cursor=" + ids[1], "archived=TRUE", "archived=true&archived=false", "ownerId=private-query-sentinel",
        })
        {
            using var response = await fixture.Client.GetAsync("/api/projects?" + query);
            var problem = await ProblemAsync(response, HttpStatusCode.BadRequest, "invalid_project_query");
            await Assert.That(problem.GetRawText().Contains("private-query-sentinel", StringComparison.Ordinal)).IsFalse();
        }
        await Assert.That(fixture.Logs.Messages.Contains("private-query-sentinel", StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    [Arguments("anonymous", HttpStatusCode.Unauthorized, "authentication_required")]
    [Arguments("forced", HttpStatusCode.Forbidden, "access_denied")]
    [Arguments("disabled", HttpStatusCode.Unauthorized, "authentication_required")]
    [Arguments("expired", HttpStatusCode.Unauthorized, "authentication_required")]
    public async Task ProjectReads_AccountPolicyReturnsSafeProblemsWithoutRedirects(string state, HttpStatusCode status, string code)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(forced: state == "forced");
        var project = await SeedAsync(fixture, actor);
        if (state != "anonymous")
        {
            await fixture.SignInAsync(actor);
        }
        if (state == "disabled")
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(row => row.Id == actor)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        }
        if (state == "expired")
        {
            fixture.Clock.Advance(TimeSpan.FromDays(1));
        }
        foreach (var path in new[] { "/api/projects", Path(project.Id) })
        {
            using var response = await fixture.Client.GetAsync(path);
            await ProblemAsync(response, status, code);
        }
    }

    [Test]
    [Arguments("corrupt")]
    [Arguments("production-assets")]
    public async Task ProjectReads_UnavailableStoredContentReturnsNoDocumentOrPartialPage(string state)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: state == "corrupt" ? "Development" : "Production");
        var actor = await fixture.CreateAccountAsync();
        await SeedAsync(fixture, actor, id: Guid.Parse("00000001-0000-4000-8000-000000000000"));
        var project = await SeedAsync(fixture, actor, id: Guid.Parse("00000002-0000-4000-8000-000000000000"));
        if (state == "corrupt")
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var invalid = JsonSerializer.Serialize(new { projectId = project.Id, schemaVersion = 1, title = BodyMarker });
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.Where(row => row.Id == project.Id)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.DocumentJson, invalid));
        }
        await fixture.SignInAsync(actor);
        foreach (var path in new[] { "/api/projects", Path(project.Id) })
        {
            using var response = await fixture.Client.GetAsync(path);
            await ProblemAsync(response, HttpStatusCode.ServiceUnavailable, "project_unavailable");
        }
        await Assert.That(fixture.Logs.Messages.Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    [Arguments(false, false)]
    [Arguments(true, false)]
    [Arguments(false, true)]
    [Arguments(true, true)]
    public async Task ProjectReads_InFlightReadsKeepOneSnapshotButDoNotOutliveTheirSession(bool list, bool expire)
    {
        var gate = new ProjectQueryPause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)),
            environmentName: "Development");
        var actor = await fixture.CreateAccountAsync();
        var project = await SeedAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var path = list ? "/api/projects" : Path(project.Id);
        gate.Arm();
        var pending = fixture.Client.GetAsync(path);
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (expire)
            {
                fixture.Clock.Set(new DateTimeOffset(long.Parse(
                    fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!, CultureInfo.InvariantCulture), TimeSpan.Zero));
            }
            else
            {
                await using var scope = fixture.Database.Services.CreateAsyncScope();
                var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
                await using var transaction = await database.Database.BeginTransactionAsync();
                await database.ProjectAssignments.Where(row => row.ProjectId == project.Id).ExecuteDeleteAsync();
                var updated = await database.Projects.SingleAsync();
                updated.Revision++;
                updated.DocumentJson = ProjectTestDocuments.Create(project.Id, "Changed after snapshot");
                await database.SaveChangesAsync();
                await transaction.CommitAsync();
            }
        }
        catch
        {
            gate.Release.TrySetResult();
            using var drained = await pending;
            throw;
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        using var response = await pending;
        if (expire)
        {
            await ProblemAsync(response, HttpStatusCode.Unauthorized, "authentication_required");
        }
        else
        {
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var item = list ? body.GetProperty("items")[0] : body;
            await Assert.That(item.GetProperty("revision").GetInt64()).IsEqualTo(project.Revision);
            await Assert.That((list ? item : item.GetProperty("document")).GetProperty("title").GetString()).IsEqualTo(BodyMarker);
            if (list)
            {
                await AssertIdsAsync(await GetAsync(fixture.Client, path));
            }
            else
            {
                using var revoked = await fixture.Client.GetAsync(path);
                await ProblemAsync(revoked, HttpStatusCode.NotFound, "project_not_found");
            }
        }
    }

    private static async Task<Project> SeedAsync(HttpsApplicationFixture fixture, Guid actor, Guid? id = null,
        string title = BodyMarker, int version = 1, bool publish = false, bool manage = false, bool archived = false,
        Guid? organization = null)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var projectId = id ?? Guid.NewGuid();
        var project = new Project
        {
            Id = projectId,
            OrganizationId = organization ?? await database.OrganizationMemberships.Where(row => row.UserId == actor)
                .Select(row => row.OrganizationId).SingleAsync(),
            SchemaVersion = version,
            DocumentJson = ProjectTestDocuments.Create(projectId, title, version),
            Revision = 7,
            UpdatedAt = DateTimeOffset.UnixEpoch.AddMinutes(123),
            IsArchived = archived,
            LastMutationActorId = actor,
            LastMutationId = Guid.NewGuid(),
            LastMutationDigest = new byte[32],
        };
        database.Projects.Add(project);
        database.ProjectAssignments.Add(new ProjectAssignment
        {
            ProjectId = projectId,
            UserId = actor,
            CanEdit = true,
            CanManage = manage,
            CanPublish = publish,
        });
        await database.SaveChangesAsync();
        return project;
    }

    private static async Task LoginAsync(HttpsApplicationFixture fixture, Guid actor, HttpClient client)
    {
        using var login = await AuthTestRequests.PostAsync(fixture, "/api/auth/login", new
        {
            userName = await AuthTestRequests.UserNameAsync(fixture, actor),
            password = AuthTestRequests.CurrentPassword,
        }, client);
        await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
    }

    private static string Path(Guid id) => "/api/projects/" + id.ToString("D");

    private static async Task<JsonElement> GetAsync(HttpClient client, string path)
    {
        using var response = await client.GetAsync(path);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(response.Headers.CacheControl?.NoStore is true).IsTrue();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task<JsonElement> ProblemAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        await AuthTestRequests.AssertProblemAsync(response, status, code);
        await Assert.That(response.Headers.CacheControl?.NoStore is true).IsTrue();
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        await AssertFieldsAsync(problem, "type", "title", "status", "code", "traceId");
        await Assert.That(problem.GetRawText().Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
        return problem;
    }

    private static async Task AssertIdsAsync(JsonElement page, params Guid[] expected) =>
        await Assert.That(page.GetProperty("items").EnumerateArray().Select(row => row.GetProperty("projectId").GetGuid())
            .SequenceEqual(expected)).IsTrue();

    private static async Task AssertFieldsAsync(JsonElement json, params string[] fields) =>
        await Assert.That(json.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(fields.Order())).IsTrue();

    private static async Task AssertPermissionsAsync(JsonElement parent, bool edit, bool manage, bool publish)
    {
        var permissions = parent.GetProperty("permissions");
        await AssertFieldsAsync(permissions, "canEdit", "canManage", "canPublish");
        await Assert.That(permissions.GetProperty("canEdit").GetBoolean()).IsEqualTo(edit);
        await Assert.That(permissions.GetProperty("canManage").GetBoolean()).IsEqualTo(manage);
        await Assert.That(permissions.GetProperty("canPublish").GetBoolean()).IsEqualTo(publish);
    }

    private sealed class ProjectQueryPause : DbCommandInterceptor
    {
        private int _armed;
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Arm() => Interlocked.Exchange(ref _armed, 1);

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("projects", StringComparison.Ordinal) && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }
}
