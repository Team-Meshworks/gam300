using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(CreationAdmissionTests))]
public sealed class CreationAdmissionTests
{
    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task FirstRepeatedConcurrentAndDelayedMissingKeysNeverCreateResources(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var before = await CountsAsync(db);
        var token = await fixture.GetCsrfAsync();
        for (var i = 0; i < 2; i++)
        {
            using var response = await SendAsync(fixture, Path(kind, source), Body(kind, document), token);
            await MissingAsync(response);
        }
        var concurrent = await Task.WhenAll(
            SendAsync(fixture, Path(kind, source), Body(kind, document), token),
            SendAsync(fixture, Path(kind, source), Body(kind, document), token));
        foreach (var response in concurrent)
        {
            using (response) { await MissingAsync(response); }
        }
        await Assert.That(await CountsAsync(db)).IsEqualTo(before);
        using var created = await SendAsync(fixture, Path(kind, source), Body(kind, document, Guid.NewGuid()), token);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var committed = await CountsAsync(db);
        using var delayed = await SendAsync(fixture, Path(kind, source), Body(kind, document), token);
        await MissingAsync(delayed);
        await Assert.That(await CountsAsync(db)).IsEqualTo(committed);
    }

    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task HeaderAndBodyBindingsReplayTheSameReceiptAndDistinctKeysKeepEqualTitlesDistinct(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var token = await fixture.GetCsrfAsync();
        var operation = Guid.NewGuid();
        using var first = await SendAsync(fixture, Path(kind, source), Body(kind, document), token, [operation.ToString("D").ToUpperInvariant()]);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var original = await first.Content.ReadAsStringAsync();
        using var bodyRetry = await SendAsync(fixture, Path(kind, source), Body(kind, document, operation), token);
        await Assert.That(bodyRetry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await bodyRetry.Content.ReadAsStringAsync()).IsEqualTo(original);
        using var both = await SendAsync(fixture, Path(kind, source), Body(kind, document, operation), token, [operation.ToString("D")]);
        await Assert.That(both.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await both.Content.ReadAsStringAsync()).IsEqualTo(original);
        var next = Guid.NewGuid();
        using var explicitBody = await SendAsync(fixture, Path(kind, source), Body(kind, document, next), token);
        await Assert.That(explicitBody.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var distinct = await explicitBody.Content.ReadAsStringAsync();
        await Assert.That(distinct).IsNotEqualTo(original);
        using var headerRetry = await SendAsync(fixture, Path(kind, source), Body(kind, document), token, [next.ToString("D")]);
        await Assert.That(headerRetry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await headerRetry.Content.ReadAsStringAsync()).IsEqualTo(distinct);
    }

    [Test]
    [Arguments("project")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task EmptyMalformedMultipleOrConflictingKeysAreRejectedBeforeMutation(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var token = await fixture.GetCsrfAsync();
        var key = Guid.NewGuid();
        var invalid = new[]
        {
            new[] { "" }, new[] { "not-a-uuid" }, new[] { Guid.Empty.ToString("D") },
            new[] { key.ToString("N") }, new[] { key.ToString("B") },
            new[] { key.ToString("D") + "," + key.ToString("D") },
            new[] { key.ToString("D"), key.ToString("D") },
        };
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var before = await CountsAsync(db);
        foreach (var headers in invalid)
        {
            using var response = await SendAsync(fixture, Path(kind, source), Body(kind, document), token, headers);
            await InvalidAsync(response);
        }
        using var emptyBody = await SendAsync(fixture, Path(kind, source), Body(kind, document, Guid.Empty), token);
        await InvalidAsync(emptyBody);
        using var conflict = await SendAsync(fixture, Path(kind, source), Body(kind, document, key), token, [Guid.NewGuid().ToString("D")]);
        await InvalidAsync(conflict);
        using var malformedHeaderWithValidBody = await SendAsync(fixture, Path(kind, source), Body(kind, document, key), token, ["invalid"]);
        await InvalidAsync(malformedHeaderWithValidBody);
        using var emptyBodyWithValidHeader = await SendAsync(fixture, Path(kind, source), Body(kind, document, Guid.Empty), token, [key.ToString("D")]);
        await InvalidAsync(emptyBodyWithValidHeader);
        var malformedBody = Body(kind, document);
        malformedBody["operationId"] = "invalid";
        using var malformed = await SendAsync(fixture, Path(kind, source), malformedBody, token, [key.ToString("D")]);
        await Assert.That(malformed.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        var extra = Body(kind, document, key);
        extra["unexpected"] = true;
        using var strict = await SendAsync(fixture, Path(kind, source), extra, token);
        await Assert.That(strict.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await Assert.That(await CountsAsync(db)).IsEqualTo(before);
    }

    [Test]
    public async Task HeaderBindingKeepsActorScopeAndGuardSemantics()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        var key = Guid.NewGuid();
        var guarded = Body("project");
        guarded["creationGuard"] = new JsonObject { ["purpose"] = "project", ["previousOperationId"] = null };
        using var first = await SendAsync(fixture, Path("project"), guarded, token, [key.ToString("D")]);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var replay = await SendAsync(fixture, Path("project"), guarded, token, [key.ToString("D")]);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var blocked = await SendAsync(fixture, Path("project"), guarded, token, [Guid.NewGuid().ToString("D")]);
        await AuthTestRequests.AssertProblemAsync(blocked, HttpStatusCode.Conflict, "creation_state_changed");
        using var otherScope = await SendAsync(fixture, Path("class"), Body("class"), token, [key.ToString("D")]);
        await AuthTestRequests.AssertProblemAsync(otherScope, HttpStatusCode.Conflict, "operation_conflict");
        using var independent = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator), independent);
        using var own = await SendAsync(fixture, Path("project"), guarded, await fixture.GetCsrfAsync(independent), [key.ToString("D")], independent);
        await Assert.That(own.StatusCode).IsEqualTo(HttpStatusCode.Created);
    }

    [Test]
    public async Task PopulatedPreReceiptUpgradeAndReopenPreserveEqualTitlesWithoutInferringHistoricalReceipts()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await db.GetService<IMigrator>().MigrateAsync("20261114115659_AddAssetRemovalReceipts");
        var organization = await db.OrganizationMemberships.Where(row => row.UserId == actor).Select(row => row.OrganizationId).SingleAsync();
        var projects = new[] { Guid.NewGuid(), Guid.NewGuid() };
        foreach (var project in projects)
        {
            db.Projects.Add(new Project
            {
                Id = project,
                OrganizationId = organization,
                SchemaVersion = 2,
                DocumentJson = ProjectTestDocuments.Create(project, "Equal title", 2),
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            db.ProjectAssignments.Add(new ProjectAssignment { ProjectId = project, UserId = actor, CanEdit = true, CanManage = true });
        }
        foreach (var classroom in new[] { Guid.NewGuid(), Guid.NewGuid() })
        {
            db.Classrooms.Add(new Classroom { Id = classroom, OrganizationId = organization, Name = "Equal title" });
            db.ClassroomMembers.Add(new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = actor, RoleId = ApplicationRoles.EducatorId });
        }
        await db.SaveChangesAsync();
        var originals = await db.Projects.AsNoTracking().OrderBy(row => row.Id).Select(row => row.DocumentJson).ToArrayAsync();
        await db.Database.MigrateAsync();
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);
        var token = await reopened.GetCsrfAsync();
        foreach (var kind in new[] { "project", "import", "duplicate", "class" })
        {
            var body = Body(kind, kind == "import" ? JsonSerializer.Deserialize<JsonElement>(originals[0]) : null);
            body[kind == "class" ? "name" : "title"] = "Equal title";
            using var historicalRetry = await SendAsync(reopened, Path(kind, projects[0]), body, token);
            await MissingAsync(historicalRetry);
        }
        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(2);
        await Assert.That(await db.Classrooms.CountAsync()).IsEqualTo(2);
        await Assert.That((await db.Projects.AsNoTracking().OrderBy(row => row.Id).Select(row => row.DocumentJson).ToArrayAsync()).SequenceEqual(originals)).IsTrue();
        using var head = await reopened.Client.GetAsync("/api/v1/creation-operations/project");
        var state = await head.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(state.GetProperty("state").GetString()).IsEqualTo("ready");
        await Assert.That(state.GetProperty("operationId").ValueKind).IsEqualTo(JsonValueKind.Null);
    }

    private static JsonObject Body(string kind, JsonElement? document = null, Guid? operation = null)
    {
        var body = new JsonObject { [kind == "class" ? "name" : "title"] = "Same title" };
        if (kind == "duplicate") { body["expectedRevision"] = 0; }
        if (kind == "import") { body["document"] = JsonNode.Parse(document!.Value.GetRawText()); }
        if (operation is { } id) { body["operationId"] = id.ToString("D"); }
        return body;
    }

    private static string Path(string kind, Guid source = default) => kind switch
    {
        "class" => "/api/v1/classes",
        "duplicate" => $"/api/v1/projects/{source:D}/duplicate",
        _ => "/api/v1/projects",
    };

    private static async Task<(Guid Source, JsonElement? Document)> SourceAsync(HttpsApplicationFixture fixture, string kind)
    {
        if (kind is not ("duplicate" or "import")) { return (Guid.Empty, null); }
        using var created = await SendAsync(fixture, Path("project"), Body("project", operation: Guid.NewGuid()), await fixture.GetCsrfAsync());
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var source = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projectId").GetGuid();
        using var opened = await fixture.Client.GetAsync($"/api/v1/projects/{source:D}");
        return (source, (await opened.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document").Clone());
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpsApplicationFixture fixture, string path, object body, string token,
        string[]? headers = null, HttpClient? client = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        request.Headers.Add("X-CSRF-TOKEN", token);
        if (headers is not null) { request.Headers.TryAddWithoutValidation("Idempotency-Key", headers); }
        return await (client ?? fixture.Client).SendAsync(request);
    }

    private static async Task MissingAsync(HttpResponseMessage response)
    {
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.BadRequest, "creation_operation_id_required");
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(problem.GetProperty("title").GetString()!.Contains("reuse", StringComparison.Ordinal)).IsTrue();
    }

    private static async Task InvalidAsync(HttpResponseMessage response)
    {
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.BadRequest, "invalid_creation_operation_id");
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
    }

    private static async Task<(int Projects, int Classes, int Images, int Receipts)> CountsAsync(ApplicationDbContext db) =>
        (await db.Projects.CountAsync(), await db.Classrooms.CountAsync(), await db.ProjectImages.CountAsync(), await db.Set<CreationReceipt>().CountAsync());
}
