using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(LegacyCreationResolutionTests))]
public sealed partial class LegacyCreationResolutionTests
{
    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ExplicitCreateBindsOriginalRequestAcrossHostsWithoutPreventingDistinctKeyedCreates(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var (source, document) = await SourceAsync(fixture, kind);
        var path = Path(kind, source);
        var body = Body(kind, document);
        var before = await CountsAsync(fixture);

        using (var rejected = await AuthTestRequests.PostAsync(fixture, path, body))
        {
            await MissingAsync(rejected, path);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);

        using var first = await ResolveAsync(fixture, path, "createAfter=initial", body);
        await SuccessAsync(first, HttpStatusCode.Created, "created");
        var original = await first.Content.ReadAsStringAsync();
        var id = Id(kind, JsonSerializer.Deserialize<JsonElement>(original));

        await Assert.That(first.Headers.Location?.OriginalString).IsEqualTo(Location(kind, id));

        await AssertCountsAsync(fixture, before, kind, 1, 1);
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);

        using (var replay = await AuthTestRequests.PostAsync(reopened, path, body))
        {
            await SuccessAsync(replay, HttpStatusCode.OK, "created");

            await Assert.That(await replay.Content.ReadAsStringAsync()).IsEqualTo(original);
            await Assert.That(replay.Headers.Location?.OriginalString).IsEqualTo(Location(kind, id));
        }

        using (var repeatedDecision = await ResolveAsync(reopened, path, "createAfter=initial", body))
        {
            await SuccessAsync(repeatedDecision, HttpStatusCode.OK, "created");

            await Assert.That(await repeatedDecision.Content.ReadAsStringAsync()).IsEqualTo(original);
        }

        using (var incompatible = await ResolveAsync(reopened, path, $"useExisting={id:D}", body))
        {
            await AuthTestRequests.AssertProblemAsync(incompatible, HttpStatusCode.Conflict, "legacy_creation_resolution_conflict");
        }

        var keyed = Body(kind, document);
        keyed["operationId"] = Guid.NewGuid().ToString("D");

        using (var distinct = await AuthTestRequests.PostAsync(reopened, path, keyed))
        {
            await Assert.That(distinct.StatusCode).IsEqualTo(HttpStatusCode.Created);
            await Assert.That(Id(kind, await distinct.Content.ReadFromJsonAsync<JsonElement>())).IsNotEqualTo(id);
        }

        using (var delayed = await AuthTestRequests.PostAsync(reopened, path, body))
        {
            await SuccessAsync(delayed, HttpStatusCode.OK, "created");

            await Assert.That(await delayed.Content.ReadAsStringAsync()).IsEqualTo(original);
        }

        await AssertCountsAsync(fixture, before, kind, 2, 2);
    }

    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ExistingSelectionIsExactImmutableAndReturnsCurrentAuthorizedMetadataWithoutReceipt(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var candidates = new[] { await SeedAsync(fixture, kind == "class" ? "class" : "project"), await SeedAsync(fixture, kind == "class" ? "class" : "project") };
        var before = await CountsAsync(fixture);
        var path = Path(kind, source);
        var body = Body(kind, document);

        using (var selected = await ResolveAsync(fixture, path, $"useExisting={candidates[1]:D}", body))
        {
            await SuccessAsync(selected, HttpStatusCode.OK, "existing");

            await Assert.That(Id(kind, await selected.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(candidates[1]);
            await Assert.That(selected.Headers.Location?.OriginalString).IsEqualTo(Location(kind, candidates[1]));
        }

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

            if (kind == "class")
            {
                await db.Classrooms.Where(row => row.Id == candidates[1]).ExecuteUpdateAsync(set => set.SetProperty(row => row.Name, "Current name"));
            }
            else
            {
                await db.Projects.Where(row => row.Id == candidates[1]).ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 7));
            }
        }

        using (var retry = await AuthTestRequests.PostAsync(fixture, path, body))
        {
            await SuccessAsync(retry, HttpStatusCode.OK, "existing");
            var current = await retry.Content.ReadFromJsonAsync<JsonElement>();

            await Assert.That(Id(kind, current)).IsEqualTo(candidates[1]);

            if (kind == "class")
                await Assert.That(current.GetProperty("name").GetString()).IsEqualTo("Current name");
            else
                await Assert.That(current.GetProperty("revision").GetInt64()).IsEqualTo(7L);
        }

        foreach (var selector in new[] { $"useExisting={candidates[0]:D}", "createAfter=initial" })
        {
            using var conflict = await ResolveAsync(fixture, path, selector, body);
            await AuthTestRequests.AssertProblemAsync(conflict, HttpStatusCode.Conflict, "legacy_creation_resolution_conflict");
        }

        var after = await CountsAsync(fixture);

        await Assert.That(after).IsEqualTo(before with
        {
            Bindings = before.Bindings + 1
        });
    }

    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task InvalidSelectorsAndUnavailableExactIdsNeverFallBackToCreating(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var path = Path(kind, source);
        var body = Body(kind, document);
        var before = await CountsAsync(fixture);
        var key = Guid.NewGuid().ToString("D");

        foreach (var selector in new[] { "", "useExisting=", "createAfter=", "useExisting=invalid", "createAfter=invalid", $"useExisting={Guid.Empty:D}", $"createAfter={Guid.Empty:D}", $"useExisting={key}&useExisting={key}", "createAfter=initial&createAfter=initial", $"useExisting={key}&createAfter=initial", "createAfter=initial&unknown=true" })
        {
            using var rejected = await ResolveAsync(fixture, path, selector, body);
            await AuthTestRequests.AssertProblemAsync(rejected, HttpStatusCode.BadRequest, "invalid_legacy_creation_resolution");
        }

        using (var missing = await ResolveAsync(fixture, path, $"useExisting={Guid.NewGuid():D}", body))
        {
            await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        var keyed = Body(kind, document);
        keyed["operationId"] = key;

        using (var forbiddenKey = await ResolveAsync(fixture, path, "createAfter=initial", keyed))
        {
            await Assert.That(forbiddenKey.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }

        var guarded = Body(kind, document);
        guarded["creationGuard"] = new JsonObject { ["purpose"] = kind, ["previousOperationId"] = null };

        using (var forbiddenGuard = await ResolveAsync(fixture, path, "createAfter=initial", guarded))
        {
            await Assert.That(forbiddenGuard.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }

        using (var request = new HttpRequestMessage(HttpMethod.Put, path + "/legacy-resolution?createAfter=initial") { Content = JsonContent.Create(body) })
        {
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            request.Headers.Add("Idempotency-Key", key);
            using var forbiddenHeader = await fixture.Client.SendAsync(request);

            await Assert.That(forbiddenHeader.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }

    [Test]
    public async Task AnonymousBodylessResolutionChallengesBeforeReadingAnyBodyOrWriting()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        using var request = new HttpRequestMessage(HttpMethod.Put, "/api/v1/projects/legacy-resolution");
        using var response = await fixture.Client.SendAsync(request);

        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await Assert.That(response.Headers.WwwAuthenticate.Single().ToString()).IsEqualTo("SpatiaSession realm=\"Spatia\", login_uri=\"/api/v1/auth/login\"");
        await Assert.That(response.Headers.Location).IsNull();
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(new Counts(0, 0, 0, 0, 0));
    }

    private static JsonObject Body(string kind, JsonElement? document = null)
    {
        var body = new JsonObject { [kind == "class" ? "name" : "title"] = "Same title" };

        if (kind == "duplicate")
            body["expectedRevision"] = 0;

        if (kind == "import")
            body["document"] = JsonNode.Parse(document!.Value.GetRawText());

        return body;
    }

    private static string Path(string kind, Guid source = default) => kind switch
    {
        "class" => "/api/v1/classes",
        "duplicate" => $"/api/v1/projects/{source:D}/duplicate",
        _ => "/api/v1/projects",
    };

    private static Guid Id(string kind, JsonElement body) => body.GetProperty(kind == "class" ? "id" : "projectId").GetGuid();

    private static string Location(string kind, Guid id) => $"/api/v1/{(kind == "class" ? "classes" : "projects")}/{id:D}";

    private static async Task<Guid> SeedAsync(HttpsApplicationFixture fixture, string kind = "project")
    {
        var body = Body(kind);
        body["operationId"] = Guid.NewGuid().ToString("D");
        using var response = await AuthTestRequests.PostAsync(fixture, Path(kind), body);

        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);

        return Id(kind, await response.Content.ReadFromJsonAsync<JsonElement>());
    }

    private static async Task<(Guid Source, JsonElement? Document)> SourceAsync(HttpsApplicationFixture fixture, string kind)
    {
        if (kind is not ("duplicate" or "import"))
            return (Guid.Empty, null);

        var source = await SeedAsync(fixture);
        using var opened = await fixture.Client.GetAsync($"/api/v1/projects/{source:D}");
        return (source, (await opened.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document").Clone());
    }

    private static async Task<HttpResponseMessage> ResolveAsync(HttpsApplicationFixture fixture, string path, string selector, object body, HttpClient? client = null, string? token = null) =>
        await AuthTestRequests.PutAsync(client ?? fixture.Client, path + "/legacy-resolution?" + selector, body, token ?? await fixture.GetCsrfAsync(client));

    private static async Task MissingAsync(HttpResponseMessage response, string path)
    {
        await AuthTestRequests.AssertProblemAsync(response, HttpStatusCode.BadRequest, "creation_operation_id_required");
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();

        await Assert.That(problem.GetProperty("resolutionUrl").GetString()).IsEqualTo(path + "/legacy-resolution");
        await Assert.That(response.Headers.GetValues("Link").Single()).IsEqualTo($"<{path}/legacy-resolution>; rel=\"related\"");
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
    }

    private static async Task SuccessAsync(HttpResponseMessage response, HttpStatusCode status, string mode)
    {
        await Assert.That(response.StatusCode).IsEqualTo(status);
        await Assert.That(response.Headers.GetValues("X-Spatia-Creation-Resolution").Single()).IsEqualTo(mode);
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
    }

    private static async Task<Counts> CountsAsync(HttpsApplicationFixture fixture)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        return new(await db.Projects.CountAsync(), await db.Classrooms.CountAsync(), await db.ProjectImages.CountAsync(), await db.Set<CreationReceipt>().CountAsync(),
            await db.Database.SqlQuery<long>($"SELECT count(*) AS \"Value\" FROM legacy_creation_bindings").SingleAsync());
    }

    private static async Task AssertCountsAsync(HttpsApplicationFixture fixture, Counts before, string kind, int resources, int receipts) =>
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before with
        {
            Projects = before.Projects + (kind == "class" ? 0 : resources),
            Classes = before.Classes + (kind == "class" ? resources : 0),
            Receipts = before.Receipts + receipts,
            Bindings = before.Bindings + 1
        });

    private sealed record Counts(int Projects, int Classes, int Images, int Receipts, long Bindings);
}
