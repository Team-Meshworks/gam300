using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;
using Format = Spatia.ProjectFormat.ProjectFormat;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ReviewSubmissionEndpointTests))]
public sealed class ReviewSubmissionEndpointTests
{
    [Test]
    [Arguments(1, "rotation")]
    [Arguments(2, "rotation")]
    [Arguments(1, "read-limit")]
    [Arguments(1, "serialize-limit")]
    public async Task ReviewSubmission_PreservesExactSavedContentAfterEditAndRestart(int version, string scenario)
    {
        var resolver = new FixtureAssets();
        await using var fixture = await CreateFixtureAsync(resolver);
        var data = await SeedAsync(fixture, false);
        var input = JsonNode.Parse(ProjectTestDocuments.Create(data.ProjectId, "Saved snapshot", version))!;
        input["scenes"]![0]!["startCamera"]!["rotation"] = scenario switch
        {
            "read-limit" => new JsonArray(0.47490965438830257, -0.6980326014100272, -0.1736294030169948, -0.5070149287205405),
            "serialize-limit" => new JsonArray(0.6267845488506097, -0.36662911366558604, 0.5535539462274982, -0.4078017299508285),
            _ => new JsonArray(-0.04334603238835914, -0.4929046071223118, 0.7105726134622642, 0.5002526669106266),
        };
        if (scenario != "rotation")
        {
            ProjectTestDocuments.PadTitleToBytes(input, Format.MaxProjectBytes);
            await using var documentScope = fixture.App.Services.CreateAsyncScope();
            var documents = documentScope.ServiceProvider.GetRequiredService<ProjectDocumentService>();
            var accepted = documents.Read(data.ProjectId, input.ToJsonString());
            await Assert.That(accepted.Ok).IsTrue();
            var saved = documents.Serialize(accepted.Value!);
            await Assert.That(saved.Ok).IsTrue();
            await Assert.That(Encoding.UTF8.GetByteCount(saved.Value!)).IsEqualTo(Format.MaxProjectBytes);
        }
        var original = input.ToJsonString();
        await Assert.That(Encoding.UTF8.GetByteCount(original) <= Format.MaxProjectBytes).IsTrue();
        if (scenario != "rotation") { await Assert.That(Encoding.UTF8.GetByteCount(original)).IsEqualTo(Format.MaxProjectBytes); }
        using (var saved = await SaveAsync(fixture, data.ProjectId, 0, original))
        { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }

        string savedJson;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            savedJson = (await database.Projects.AsNoTracking().SingleAsync(row => row.Id == data.ProjectId)).DocumentJson;
        }
        if (scenario != "rotation") { await Assert.That(Encoding.UTF8.GetByteCount(savedJson) > Format.MaxProjectBytes).IsTrue(); }
        var submissionId = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submissionId, 1, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var edited = await SaveAsync(fixture, data.ProjectId, 1))
        { await Assert.That(edited.StatusCode).IsEqualTo(HttpStatusCode.OK); }

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var evidence = await database.ReviewSubmissions.AsNoTracking().SingleAsync();
            await Assert.That(evidence.DocumentJson).IsEqualTo(savedJson);
            await Assert.That(evidence.SourceRevision).IsEqualTo(1L);
            await Assert.That(evidence.AssetReferencesJson.Contains(new string('a', 64), StringComparison.Ordinal)).IsTrue();
        }
        await fixture.App.StopAsync();
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(data.Educator);
        using var detail = await restarted.Client.GetAsync($"/api/v1/projects/{data.ProjectId:D}/submissions/{submissionId:D}");
        await Assert.That(detail.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var history = await detail.Content.ReadFromJsonAsync<JsonElement>();
        using var expected = JsonDocument.Parse(savedJson);
        await Assert.That(JsonElement.DeepEquals(history.GetProperty("document"), expected.RootElement)).IsTrue();
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task ReviewSubmission_CapturesSavedRevisionAndReconcilesRetries(bool late)
    {
        var resolver = new FixtureAssets();
        await using var fixture = await CreateFixtureAsync(resolver);
        var data = await SeedAsync(fixture, late);
        var id = Guid.NewGuid();
        using (var created = await SubmitAsync(fixture, data.ProjectId, id, 0, true))
        {
            await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
            var result = await created.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(result.GetProperty("submissionId").GetGuid()).IsEqualTo(id);
            await Assert.That(result.GetProperty("revision").GetInt64()).IsEqualTo(0L);
            await Assert.That(result.GetProperty("dueAtUnixSeconds").GetInt64()).IsEqualTo(data.Due);
            await Assert.That(result.GetProperty("isLate").GetBoolean()).IsEqualTo(late);
        }
        using (var replay = await SubmitAsync(fixture, data.ProjectId, id, 0, true))
        { await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        await Assert.That(resolver.Calls).IsEqualTo(1);
        await Assert.That(resolver.LastIds.SetEquals(["test-room-v1", "test-crate-v1"])).IsTrue();

        using (var saved = await SaveAsync(fixture, data.ProjectId))
        { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var replay = await SubmitAsync(fixture, data.ProjectId, id, 0, true))
        { await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var changed = await SubmitAsync(fixture, data.ProjectId, id, 1, true))
        { await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        using (var stale = await SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, true))
        { await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var submission = await database.ReviewSubmissions.AsNoTracking().SingleAsync();
        await Assert.That(submission.SourceRevision).IsEqualTo(0L);
        await Assert.That(submission.DocumentJson.Contains("Student draft", StringComparison.Ordinal)).IsTrue();
        await Assert.That(submission.DocumentJson.Contains("Newer draft", StringComparison.Ordinal)).IsFalse();
        await Assert.That(submission.AssetReferencesJson.Contains(new string('a', 64), StringComparison.Ordinal)).IsTrue();
        await Assert.That((await database.Projects.SingleAsync(row => row.Id == data.ProjectId)).Revision).IsEqualTo(1L);
    }

    [Test]
    public async Task ReviewSubmission_RejectsOtherStudentsEducatorsAndInvalidInputs()
    {
        var resolver = new FixtureAssets();
        await using var fixture = await CreateFixtureAsync(resolver);
        var data = await SeedAsync(fixture, false);
        using (var unconfirmed = await SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, false))
        { await Assert.That(unconfirmed.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var missingId = await SubmitAsync(fixture, data.ProjectId, Guid.Empty, 0, true))
        { await Assert.That(missingId.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using var other = fixture.CreateClient();
        await fixture.SignInAsync(data.OtherStudent, other);
        using (var denied = await SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, true, other))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var denied = await SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, true, educator))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }
        await Assert.That(resolver.Calls).IsEqualTo(0);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewSubmissions.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments("unavailable")]
    [Arguments("incomplete")]
    [Arguments("invalid")]
    public async Task ReviewSubmission_UnavailableOrInvalidAssetResolutionLeavesNoEvidence(string mode)
    {
        var resolver = new FixtureAssets { Mode = mode };
        await using var fixture = await CreateFixtureAsync(resolver);
        var data = await SeedAsync(fixture, false);
        using var denied = await SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, true);
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        await Assert.That((await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString())
            .IsEqualTo("review_assets_unavailable");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewSubmissions.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task ReviewSubmission_DefaultAssetResolverFailsClosed()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        using var denied = await SubmitAsync(fixture, data.ProjectId, Guid.NewGuid(), 0, true);
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewSubmissions.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task ReviewSubmission_ConcurrentIdenticalRetriesCreateOnlyOneSnapshot()
    {
        var resolver = new FixtureAssets();
        await using var fixture = await CreateFixtureAsync(resolver);
        var data = await SeedAsync(fixture, false);
        var id = Guid.NewGuid();
        var token = await fixture.GetCsrfAsync();
        var results = await Task.WhenAll(SubmitAsync(fixture, data.ProjectId, id, 0, true, token: token),
            SubmitAsync(fixture, data.ProjectId, id, 0, true, token: token));
        try
        {
            await Assert.That(results.Count(row => row.StatusCode == HttpStatusCode.Created)).IsEqualTo(1);
            await Assert.That(results.Count(row => row.StatusCode == HttpStatusCode.OK)).IsEqualTo(1);
            await Assert.That(resolver.Calls).IsEqualTo(1);
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewSubmissions.CountAsync()).IsEqualTo(1);
        }
        finally { foreach (var response in results) { response.Dispose(); } }
    }

    internal static Task<HttpsApplicationFixture> CreateFixtureAsync(FixtureAssets assets) =>
        HttpsApplicationFixture.CreateAsync(builder => builder.Services.AddSingleton<IReviewAssetResolver>(assets), environmentName: "Development");

    internal static async Task<Seeded> SeedAsync(HttpsApplicationFixture fixture, bool late)
    {
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var other = await fixture.CreateAccountAsync();
        var classroom = Guid.NewGuid();
        var source = Guid.NewGuid();
        var project = Guid.NewGuid();
        var assignment = Guid.NewGuid();
        var due = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + (late ? -3600 : 3600);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == educator)
                .Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == student || row.UserId == other)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            database.Classrooms.Add(new Classroom { Id = classroom, OrganizationId = organization, Name = "Review class" });
            database.ClassroomMembers.AddRange(
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = student, RoleId = ApplicationRoles.CreatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = other, RoleId = ApplicationRoles.CreatorId });
            database.Projects.AddRange(NewProject(source, organization, "Source"), NewProject(project, organization, "Student draft"));
            database.ProjectAssignments.AddRange(
                new ProjectAssignment { ProjectId = project, UserId = educator, CanEdit = true, CanManage = true, CanPublish = true },
                new ProjectAssignment { ProjectId = project, UserId = student, CanEdit = true });
            database.ClassAssignments.Add(new ClassAssignment
            {
                Id = assignment,
                ClassroomId = classroom,
                OrganizationId = organization,
                CreatedByUserId = educator,
                SourceProjectId = source,
                SourceRevision = 0,
                DueAtUnixSeconds = due,
                Title = "Assignment",
                Description = "Description",
                Instructions = "Instructions",
                RequestDigest = new byte[32],
            });
            database.ClassAssignmentStudents.Add(new ClassAssignmentStudent
            {
                AssignmentId = assignment,
                ClassroomId = classroom,
                OrganizationId = organization,
                StudentId = student,
                ProjectId = project,
            });
            database.ProjectProvenances.Add(new ProjectProvenance
            {
                ProjectId = project,
                OrganizationId = organization,
                Kind = ProjectProvenance.Class,
                ClassAssignmentId = assignment,
                StudentId = student,
            });
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(student);
        return new(educator, student, other, classroom, assignment, project, due);
    }

    private static Project NewProject(Guid id, Guid organization, string title) => new()
    {
        Id = id,
        OrganizationId = organization,
        SchemaVersion = 1,
        DocumentJson = ProjectTestDocuments.Create(id, title),
        UpdatedAt = DateTimeOffset.UtcNow,
    };

    internal static async Task<HttpResponseMessage> SubmitAsync(HttpsApplicationFixture fixture, Guid projectId, Guid submissionId,
        long revision, bool confirmed, HttpClient? client = null, string? token = null)
    {
        client ??= fixture.Client;
        using var message = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{projectId:D}/submissions")
        {
            Content = JsonContent.Create(new { submissionId, expectedRevision = revision, completionConfirmed = confirmed }),
        };
        message.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(message);
    }

    internal static async Task<HttpResponseMessage> SaveAsync(HttpsApplicationFixture fixture, Guid projectId,
        long revision = 0, string? json = null)
    {
        using var document = JsonDocument.Parse(json ?? ProjectTestDocuments.Create(projectId, "Newer draft"));
        using var message = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/projects/{projectId:D}")
        {
            Content = JsonContent.Create(new { expectedRevision = revision, clientMutationId = Guid.NewGuid(), document = document.RootElement }),
        };
        message.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(message);
    }

    internal sealed record Seeded(Guid Educator, Guid Student, Guid OtherStudent, Guid ClassroomId, Guid AssignmentId, Guid ProjectId, long Due);

    internal sealed class FixtureAssets : IReviewAssetResolver
    {
        public string Mode { get; init; } = "valid";
        public int Calls;
        public HashSet<string> LastIds { get; private set; } = new(StringComparer.Ordinal);
        public Task<IReadOnlyCollection<ReviewAssetReference>?> ResolveAsync(ApplicationDbContext database,
            ProjectAccessSnapshot project, IReadOnlySet<string> assetIds, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            LastIds = assetIds.ToHashSet(StringComparer.Ordinal);
            IReadOnlyCollection<ReviewAssetReference>? result = Mode switch
            {
                "unavailable" => null,
                "incomplete" => [new(assetIds.First(), new string('a', 64))],
                "invalid" => assetIds.Select(id => new ReviewAssetReference(id, "bad")).ToArray(),
                _ => assetIds.Select(id => new ReviewAssetReference(id, new string('a', 64))).ToArray(),
            };
            return Task.FromResult(result);
        }
    }
}
