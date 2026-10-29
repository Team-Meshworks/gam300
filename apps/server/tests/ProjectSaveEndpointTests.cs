using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectSaveEndpointTests
{
    private const string BodyMarker = "private-put-document-not-for-errors-or-logs";

    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task ProjectPut_SaveOpenExactRetryAndChangedRetryUseOneCommittedRevision(int version)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var document = ProjectTestDocuments.Create(project.Id, BodyMarker, version);
        var body = Envelope(document, Guid.NewGuid());
        using var first = await PutAsync(fixture, project.Id, body);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var acknowledgement = await first.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(acknowledgement.EnumerateObject().Select(field => field.Name).Order()
            .SequenceEqual(new[] { "clientMutationId", "projectId", "revision", "savedAt" })).IsTrue();
        await Assert.That(acknowledgement.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        await Assert.That(acknowledgement.GetProperty("projectId").GetGuid()).IsEqualTo(project.Id);
        using var retry = await PutAsync(fixture, project.Id, body);
        await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(JsonElement.DeepEquals(await retry.Content.ReadFromJsonAsync<JsonElement>(), acknowledgement)).IsTrue();
        var stored = await ReadAsync(fixture);
        using var reopened = await fixture.Client.GetAsync(Path(project.Id));
        await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var opened = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        var documents = fixture.App.Services.GetRequiredService<ProjectDocumentService>();
        using var expected = JsonDocument.Parse(documents.Serialize(documents.Read(project.Id, document).Value!).Value!);
        await Assert.That(JsonElement.DeepEquals(opened.GetProperty("document"), expected.RootElement)).IsTrue();
        await Assert.That(opened.GetProperty("revision").GetInt64()).IsEqualTo(1L);
        await Assert.That(acknowledgement.GetProperty("savedAt").GetDateTimeOffset()).IsEqualTo(stored.UpdatedAt);
        using var changed = await PutAsync(fixture, project.Id, body.Replace(BodyMarker, "Changed", StringComparison.Ordinal));
        await AssertProblemAsync(fixture, changed, HttpStatusCode.Conflict, "revision_conflict", 1);
        using var stale = await PutAsync(fixture, project.Id, Envelope(document, Guid.NewGuid()));
        await AssertProblemAsync(fixture, stale, HttpStatusCode.Conflict, "revision_conflict", 1);
        await AssertUnchangedAsync(await ReadAsync(fixture), stored);
    }

    [Test]
    public async Task ProjectPut_InvalidEnvelopeAndDocumentsPreserveTheLatestSavedDraftAndRetry()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var document = ProjectTestDocuments.Create(project.Id, BodyMarker);
        var body = Envelope(document, Guid.NewGuid());
        using var original = await PutAsync(fixture, project.Id, body);
        await Assert.That(original.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var stored = await ReadAsync(fixture);
        foreach (var (invalid, status, code) in new[]
        {
            ("{", HttpStatusCode.BadRequest, "invalid_json"),
            ("{\"ownerId\":\"" + BodyMarker + "\"," + body[1..], HttpStatusCode.BadRequest, "invalid_envelope"),
            (body.Replace("\"expectedRevision\":0", "\"expectedRevision\":-1", StringComparison.Ordinal), HttpStatusCode.BadRequest, "invalid_expected_revision"),
            (Envelope(ProjectTestDocuments.Create(Guid.NewGuid(), BodyMarker), Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "project_id_mismatch"),
            (Envelope("{\"permissions\":{\"canEdit\":true}," + document[1..], Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "invalid_document"),
            (Envelope(document.Replace("test-crate-v1", "unapproved-asset", StringComparison.Ordinal), Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "invalid_document"),
            (Envelope(ProjectTestDocuments.Create(project.Id, "before\0after"), Guid.NewGuid(), 1), HttpStatusCode.UnprocessableEntity, "invalid_document"),
        })
        {
            using var response = await PutAsync(fixture, project.Id, invalid);
            await AssertProblemAsync(fixture, response, status, code);
            await AssertUnchangedAsync(await ReadAsync(fixture), stored);
        }
        using var replay = await PutAsync(fixture, project.Id, body);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await replay.Content.ReadAsStringAsync()).IsEqualTo(await original.Content.ReadAsStringAsync());
        await AssertUnchangedAsync(await ReadAsync(fixture), stored);
    }

    [Test]
    [Arguments("unassigned", HttpStatusCode.NotFound, "project_not_found")]
    [Arguments("other-organization", HttpStatusCode.NotFound, "project_not_found")]
    [Arguments("archived", HttpStatusCode.Forbidden, "project_read_only")]
    public async Task ProjectPut_DeniedMatchingRetryDoesNotDiscloseOrAlterSavedState(string state, HttpStatusCode status, string code)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var body = Envelope(ProjectTestDocuments.Create(project.Id, BodyMarker), Guid.NewGuid());
        using var original = await PutAsync(fixture, project.Id, body);
        await Assert.That(original.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var stored = await ReadAsync(fixture);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (state == "unassigned")
            {
                await database.ProjectAssignments.ExecuteDeleteAsync();
            }
            else
            {
                var row = await database.Projects.SingleAsync();
                if (state == "archived")
                {
                    row.IsArchived = true;
                }
                else
                {
                    var other = new Organization { Id = Guid.NewGuid(), Name = "Other organization" };
                    database.Organizations.Add(other);
                    row.OrganizationId = other.Id;
                }
                await database.SaveChangesAsync();
            }
        }
        using var denied = await PutAsync(fixture, project.Id, body);
        await AssertProblemAsync(fixture, denied, status, code);
        await AssertUnchangedAsync(await ReadAsync(fixture), stored);
    }

    [Test]
    public async Task ProjectPut_ConcurrentRequestsFromOneRevisionCommitOnlyOneDraft()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var project = await SeedAsync(fixture);
        var csrf = await fixture.GetCsrfAsync();
        var bodies = new[] { "First", "Second" }.Select(title => Envelope(ProjectTestDocuments.Create(project.Id, title), Guid.NewGuid())).ToArray();
        var responses = await Task.WhenAll(bodies.Select(body => PutAsync(fixture, project.Id, body, csrf)));
        try
        {
            await Assert.That(responses.Count(response => response.StatusCode == HttpStatusCode.OK)).IsEqualTo(1);
            var loser = responses.Single(response => response.StatusCode != HttpStatusCode.OK);
            await AssertProblemAsync(fixture, loser, HttpStatusCode.Conflict, "revision_conflict", 1);
            var stored = await ReadAsync(fixture);
            await Assert.That(stored.Revision).IsEqualTo(1L);
            using var winner = JsonDocument.Parse(bodies[Array.FindIndex(responses, response => response.StatusCode == HttpStatusCode.OK)]);
            await Assert.That(stored.LastMutationId).IsEqualTo((Guid?)winner.RootElement.GetProperty("clientMutationId").GetGuid());
            using var actual = JsonDocument.Parse(stored.DocumentJson);
            await Assert.That(actual.RootElement.GetProperty("title").GetString())
                .IsEqualTo(winner.RootElement.GetProperty("document").GetProperty("title").GetString());
        }
        finally
        {
            foreach (var response in responses) { response.Dispose(); }
        }
    }

    [Test]
    public async Task ProjectPut_CommitFailureReturnsSafeStorageProblemAndRollsBack()
    {
        var failure = new CommitFailure();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)),
            environmentName: "Development");
        var project = await SeedAsync(fixture);
        var before = await ReadAsync(fixture);
        var csrf = await fixture.GetCsrfAsync();
        failure.Armed = true;
        using var response = await PutAsync(fixture, project.Id, Envelope(ProjectTestDocuments.Create(project.Id, BodyMarker), Guid.NewGuid()), csrf);
        await AssertProblemAsync(fixture, response, HttpStatusCode.ServiceUnavailable, "storage_unavailable");
        await AssertUnchangedAsync(await ReadAsync(fixture), before);
    }

    private static string Path(Guid id) => "/api/projects/" + id.ToString("D");
    private static string Envelope(string document, Guid mutation, long revision = 0) =>
        $$"""{"expectedRevision":{{revision}},"clientMutationId":"{{mutation:D}}","document":{{document}}}""";

    private static async Task<Project> SeedAsync(HttpsApplicationFixture fixture)
    {
        var actor = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var id = Guid.NewGuid();
        var project = new Project
        {
            Id = id,
            OrganizationId = await database.Organizations.Select(row => row.Id).SingleAsync(),
            SchemaVersion = 1,
            DocumentJson = ProjectTestDocuments.Create(id, "Original"),
            UpdatedAt = DateTimeOffset.UnixEpoch
        };
        database.Projects.Add(project);
        database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = actor, CanEdit = true });
        await database.SaveChangesAsync();
        await fixture.SignInAsync(actor);
        return project;
    }

    private static async Task<HttpResponseMessage> PutAsync(HttpsApplicationFixture fixture, Guid id, string body, string? csrf = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, Path(id)) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-CSRF-TOKEN", csrf ?? await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }

    private static async Task<Project> ReadAsync(HttpsApplicationFixture fixture)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.AsNoTracking().SingleAsync();
    }

    private static async Task AssertUnchangedAsync(Project actual, Project expected)
    {
        await Assert.That(actual.DocumentJson).IsEqualTo(expected.DocumentJson);
        await Assert.That(actual.SchemaVersion).IsEqualTo(expected.SchemaVersion);
        await Assert.That(actual.Revision).IsEqualTo(expected.Revision);
        await Assert.That(actual.UpdatedAt).IsEqualTo(expected.UpdatedAt);
        await Assert.That(actual.LastMutationId).IsEqualTo(expected.LastMutationId);
        await Assert.That(actual.LastMutationActorId).IsEqualTo(expected.LastMutationActorId);
        await Assert.That(actual.LastMutationDigest is null ? expected.LastMutationDigest is null
            : expected.LastMutationDigest is not null && actual.LastMutationDigest.SequenceEqual(expected.LastMutationDigest)).IsTrue();
    }

    private static async Task AssertProblemAsync(HttpsApplicationFixture fixture, HttpResponseMessage response,
        HttpStatusCode status, string code, long? revision = null)
    {
        await AuthTestRequests.AssertProblemAsync(response, status, code);
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        var fields = new[] { "type", "title", "status", "code", "traceId" }.Concat(revision is null ? [] : new[] { "currentRevision" });
        await Assert.That(problem.EnumerateObject().Select(field => field.Name).Order().SequenceEqual(fields.Order())).IsTrue();
        if (revision is not null) { await Assert.That(problem.GetProperty("currentRevision").GetInt64()).IsEqualTo(revision.Value); }
        await Assert.That(problem.GetRawText().Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
    }

    private sealed class CommitFailure : DbTransactionInterceptor
    {
        public bool Armed { get; set; }
        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed) { Armed = false; throw new NpgsqlException(BodyMarker); }
            return ValueTask.FromResult(result);
        }
    }
}
