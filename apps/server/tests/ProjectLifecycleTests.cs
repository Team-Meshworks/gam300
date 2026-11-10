using System.Data;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ProjectLifecycleTests))]
public sealed class ProjectLifecycleTests
{
    private const string Marker = "private-lifecycle-document-not-for-errors-or-logs";

    // Exercise the actual creation boundary, private bytes and copy semantics in one focused round trip
    [Test]
    [Arguments("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO0iapgYGAAAAUYARBocWoMAAAAAElFTkSuQmCC")]
    [Arguments("image/jpeg", "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk6KKK9I4D/9k=")]
    [Arguments("image/webp", "UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAEAAUAmJQBOl0AAcwAA/vDXA+KAUjhzvzfY9pgAAA==")]
    public async Task ProjectImages_CreateAndDuplicateRetainPrivateBytes(string contentType, string encoded)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var data = Convert.FromBase64String(encoded);
        var id = await CreateAsync(fixture, new { title = Marker, image = new { type = "panorama", contentType, data } });
        var path = $"/api/v1/projects/{id:D}/image";
        using (var image = await fixture.Client.GetAsync(path))
        {
            await Assert.That(image.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(image.Content.Headers.ContentType!.MediaType).IsEqualTo(contentType);
            await Assert.That(await image.Content.ReadAsByteArrayAsync()).IsEquivalentTo(data);
            await Assert.That(image.Headers.CacheControl!.NoStore).IsTrue();
        }
        using (var listed = await fixture.Client.GetAsync("/api/v1/projects"))
        {
            var metadata = (await listed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items")[0].GetProperty("image");
            await Assert.That(metadata.GetProperty("type").GetString()).IsEqualTo("panorama");
            await Assert.That(metadata.GetProperty("url").GetString()).IsEqualTo(path);
        }
        using var duplicate = await SendAsync(fixture, HttpMethod.Post, Path(id, "/duplicate"), new { expectedRevision = 0, title = "Copy" });
        var copyId = (await MetadataAsync(duplicate, HttpStatusCode.Created, 0)).GetProperty("projectId").GetGuid();
        using (var copy = await fixture.Client.GetAsync($"/api/v1/projects/{copyId:D}/image"))
        { await Assert.That(await copy.Content.ReadAsByteArrayAsync()).IsEquivalentTo(data); }
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.ProjectImages.CountAsync()).IsEqualTo(1);
            // Removing a current grant must immediately deny image reads, including after a prior successful load
            await database.ProjectAssignments.Where(row => row.ProjectId == id && row.UserId == actor).ExecuteDeleteAsync();
        }
        using var denied = await fixture.Client.GetAsync(path);
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task ProjectImages_InvalidUploadDoesNotCreateAProjectOrImage()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        foreach (var image in new[]
        {
            new ProjectImageUpload("cover", "image/png", new byte[] { 137, 80, 78, 71 }),
            new ProjectImageUpload("cover", "image/svg+xml", "<svg/>"u8.ToArray()),
            new ProjectImageUpload("panorama", "image/png", Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC")),
            new ProjectImageUpload("cover", "image/png", Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAEAEAAAABCAIAAAA+gZcVAAAAI0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAgA4MMAQAAVBo6+cAAAAASUVORK5CYII=")),
            new ProjectImageUpload("cover", "image/png", new byte[ProjectImageValidation.MaximumBytes + 1]),
            new ProjectImageUpload("unknown", "image/png", Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO0iapgYGAAAAUYARBocWoMAAAAAElFTkSuQmCC")),
        })
        {
            using var response = await SendAsync(fixture, HttpMethod.Post, "/api/v1/projects", new { title = Marker, image });
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.ProjectImages.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments(ApplicationRoles.Educator)]
    [Arguments(ApplicationRoles.Creator)]
    public async Task ProjectLifecycle_MemberCanStartWithoutAnAdministratorProvidedSpace(string role)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(role);
        await fixture.SignInAsync(actor);
        var id = await CreateAsync(fixture, new { title = Marker });
        var opened = await OpenAsync(fixture, id);
        var scene = opened.GetProperty("document").GetProperty("scenes")[0];
        await Assert.That(scene.GetProperty("environmentAssetId").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(opened.GetProperty("permissions").GetProperty("canManage").GetBoolean())
            .IsEqualTo(role == ApplicationRoles.Educator);
        var edited = JsonNode.Parse(opened.GetProperty("document").GetRawText())!;
        edited["scenes"]![0]!["name"] = "Edited empty scene";
        using var saved = await SendAsync(fixture, HttpMethod.Put, $"/api/v1/projects/{id:D}",
            new { expectedRevision = 0, clientMutationId = Guid.NewGuid(), document = edited });
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var reopened = await OpenAsync(fixture, id);
        await Assert.That(reopened.GetProperty("document").GetProperty("scenes")[0].GetProperty("name").GetString())
            .IsEqualTo("Edited empty scene");
    }

    [Test]
    public async Task ProjectLifecycle_EducatorWithoutOrganizationCannotCreateInAnotherOrganization()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var other = await fixture.CreateAccountAsync();
        var otherOrganization = await OrganizationAsync(fixture, other);
        await fixture.SignInAsync(educator);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.OrganizationMemberships.Where(row => row.UserId == educator).ExecuteDeleteAsync();
        }
        using var response = await SendAsync(fixture, HttpMethod.Post, "/api/v1/projects", new { title = Marker, orgId = otherOrganization });
        await Assert.That(response.StatusCode).IsNotEqualTo(HttpStatusCode.Created);
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await verify.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task ProjectLifecycle_EducatorCannotCreateWhenOrganizationIsInactive()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var organization = await OrganizationAsync(fixture, educator);
        await fixture.SignInAsync(educator);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.Organizations.Where(row => row.Id == organization)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        }
        using var response = await SendAsync(fixture, HttpMethod.Post, "/api/v1/projects", new { title = Marker });
        await Assert.That(response.StatusCode).IsNotEqualTo(HttpStatusCode.Created);
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await verify.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments(ApplicationRoles.Creator)]
    [Arguments(ApplicationRoles.Educator)]
    [Arguments(ApplicationRoles.Administrator)]
    public async Task ProjectLifecycle_BlankCreationDerivesOrganizationAndInitialAuthority(string role)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(role);
        var organization = await OrganizationAsync(fixture, actor);
        await fixture.SignInAsync(actor);
        var id = await CreateAsync(fixture, new { title = Marker, environmentAssetId = "test-room-v1", orgId = role == ApplicationRoles.Administrator ? organization : (Guid?)null });
        var stored = await ReadAsync(fixture, id);
        await Assert.That(stored.OrganizationId).IsEqualTo(organization);
        await Assert.That(stored.Revision).IsEqualTo(0L);
        await Assert.That(stored.LastMutationId is null && stored.LastMutationActorId is null && stored.LastMutationDigest is null).IsTrue();
        var opened = await OpenAsync(fixture, id);
        await Assert.That(opened.GetProperty("document").GetProperty("title").GetString()).IsEqualTo(Marker);
        await Assert.That(opened.GetProperty("document").GetProperty("scenes")[0].GetProperty("objects").GetArrayLength()).IsEqualTo(0);
        var permissions = opened.GetProperty("permissions");
        await Assert.That(permissions.GetProperty("canEdit").GetBoolean()).IsTrue();
        await Assert.That(permissions.GetProperty("canManage").GetBoolean()).IsEqualTo(role != ApplicationRoles.Creator);
        await Assert.That(permissions.GetProperty("canPublish").GetBoolean()).IsEqualTo(role != ApplicationRoles.Creator);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var assignments = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectAssignments.ToListAsync();
        await Assert.That(assignments.Count).IsEqualTo(role == ApplicationRoles.Administrator ? 0 : 1);
        if (assignments.Count == 1) { await Assert.That(assignments[0].UserId).IsEqualTo(actor); }
    }

    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task ProjectLifecycle_ImportAndDuplicatePreserveReferencesButNeverCopyAuthorityOrMutableDrafts(int version)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(actor);
        using var imported = JsonDocument.Parse(ProjectTestDocuments.Create(Guid.NewGuid(), "Import title", version));
        var source = await CreateAsync(fixture, new { title = "Source", document = imported.RootElement });
        await Assert.That(source).IsNotEqualTo(imported.RootElement.GetProperty("projectId").GetGuid());
        var sourceBody = (await OpenAsync(fixture, source)).GetProperty("document");
        await Assert.That(JsonElement.DeepEquals(sourceBody.GetProperty("scenes"), imported.RootElement.GetProperty("scenes"))).IsTrue();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.ProjectAssignments.ExecuteUpdateAsync(set => set.SetProperty(row => row.CanPublish, true));
        }
        using var copied = await SendAsync(fixture, HttpMethod.Post, Path(source, "/duplicate"), new { expectedRevision = 0, title = "Copy" });
        var copyMetadata = await MetadataAsync(copied, HttpStatusCode.Created, 0);
        var copy = copyMetadata.GetProperty("projectId").GetGuid();
        await Assert.That(copy).IsNotEqualTo(source);
        var opened = await OpenAsync(fixture, copy);
        await Assert.That(JsonElement.DeepEquals(opened.GetProperty("document").GetProperty("scenes"), sourceBody.GetProperty("scenes"))).IsTrue();
        await Assert.That(opened.GetProperty("permissions").GetProperty("canPublish").GetBoolean()).IsFalse();
        await Assert.That(opened.GetProperty("permissions").GetProperty("canManage").GetBoolean()).IsFalse();
        using var saved = await SendAsync(fixture, HttpMethod.Put, Path(copy), Save(copy, "Changed copy", 0, version));
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await ReadAsync(fixture, source)).Revision).IsEqualTo(0L);
        await Assert.That(JsonElement.DeepEquals((await OpenAsync(fixture, source)).GetProperty("document"), sourceBody)).IsTrue();
        await Assert.That((await OpenAsync(fixture, copy)).GetProperty("document").GetProperty("title").GetString()).IsEqualTo("Changed copy");
        using var stale = await SendAsync(fixture, HttpMethod.Post, Path(copy, "/duplicate"), new { expectedRevision = 0, title = Marker });
        await ProblemAsync(fixture, stale, HttpStatusCode.Conflict, "revision_conflict", 1);
    }

    [Test]
    public async Task ProjectLifecycle_AdministratorProvisionsAndReassignsStudentsWithoutExposingOtherWork()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        using var organizationResponse = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/organizations", new { name = "Class" });
        await Assert.That(organizationResponse.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var organization = (await organizationResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var students = new List<Guid>();
        foreach (var name in new[] { "student-one", "student-two" })
        {
            using var provisioned = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/users", new
            { userName = name, initialPassword = AuthTestRequests.CurrentPassword, role = ApplicationRoles.Creator, orgId = organization });
            await Assert.That(provisioned.StatusCode).IsEqualTo(HttpStatusCode.Created);
            students.Add((await provisioned.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("userId").GetGuid());
        }
        var project = await CreateAsync(fixture, new { title = Marker, environmentAssetId = "test-room-v1", orgId = organization });
        using var assigned = await SendAsync(fixture, HttpMethod.Patch, Path(project, "/assignments"), Assignments(0, [students[0]], publish: [students[0]]));
        await MetadataAsync(assigned, HttpStatusCode.OK, 1);
        using var firstClient = fixture.CreateClient();
        using var secondClient = fixture.CreateClient();
        foreach (var (name, client) in new[] { ("student-one", firstClient), ("student-two", secondClient) })
        {
            using var login = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/login", new { userName = name, password = AuthTestRequests.CurrentPassword }, client);
            await Assert.That(login.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            using var password = await AuthTestRequests.PostAsync(fixture, "/api/v1/auth/password", new { currentPassword = AuthTestRequests.CurrentPassword, newPassword = AuthTestRequests.NewPassword }, client);
            await Assert.That(password.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        await Assert.That((await OpenAsync(fixture, project, firstClient)).GetProperty("permissions").GetProperty("canPublish").GetBoolean()).IsTrue();
        using var excluded = await secondClient.GetAsync(Path(project));
        await ProblemAsync(fixture, excluded, HttpStatusCode.NotFound, "project_not_found");
        using var reassigned = await SendAsync(fixture, HttpMethod.Patch, Path(project, "/assignments"), Assignments(1, [students[1]]));
        await MetadataAsync(reassigned, HttpStatusCode.OK, 2);
        using var removed = await firstClient.GetAsync(Path(project));
        await ProblemAsync(fixture, removed, HttpStatusCode.NotFound, "project_not_found");
        using var firstList = await firstClient.GetAsync("/api/v1/projects");
        using var secondList = await secondClient.GetAsync("/api/v1/projects");
        await Assert.That((await firstList.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0);
        await Assert.That((await secondList.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items")[0].GetProperty("projectId").GetGuid()).IsEqualTo(project);
        await Assert.That((await OpenAsync(fixture, project, secondClient)).GetProperty("permissions").GetProperty("canPublish").GetBoolean()).IsFalse();
    }

    [Test]
    public async Task ProjectLifecycle_ArchiveReopenAndAssignmentsPreserveSavedContentAndHistoricalRetry()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var id = await CreateAsync(fixture, new { title = "Initial", environmentAssetId = "test-room-v1" });
        var save = Save(id, Marker, 0);
        using var saved = await SendAsync(fixture, HttpMethod.Put, Path(id), save);
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var before = await ReadAsync(fixture, id);
        using var archived = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/archive"), new { expectedRevision = 1, archived = true });
        await MetadataAsync(archived, HttpStatusCode.OK, 2);
        var snapshot = await ReadAsync(fixture, id);
        await Assert.That(snapshot.DocumentJson).IsEqualTo(before.DocumentJson);
        await Assert.That(snapshot.IsArchived && snapshot.LastMutationId is null && snapshot.LastMutationActorId is null && snapshot.LastMutationDigest is null).IsTrue();
        var permissions = (await OpenAsync(fixture, id)).GetProperty("permissions");
        await Assert.That(permissions.GetProperty("canManage").GetBoolean()).IsTrue();
        await Assert.That(permissions.GetProperty("canEdit").GetBoolean() || permissions.GetProperty("canPublish").GetBoolean()).IsFalse();
        foreach (var (method, suffix, body) in new[]
        {
            (HttpMethod.Put, "", save),
            (HttpMethod.Post, "/duplicate", (object)new { expectedRevision = 2, title = "Copy" }),
            (HttpMethod.Patch, "/assignments", Assignments(2, [], [actor]))
        })
        {
            using var rejected = await SendAsync(fixture, method, Path(id, suffix), body);
            await ProblemAsync(fixture, rejected, HttpStatusCode.Forbidden, "project_read_only");
        }
        using var stale = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/archive"), new { expectedRevision = 1, archived = false });
        await ProblemAsync(fixture, stale, HttpStatusCode.Conflict, "revision_conflict", 2);
        using var reopened = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/archive"), new { expectedRevision = 2, archived = false });
        await MetadataAsync(reopened, HttpStatusCode.OK, 3);
        using var oldRetry = await SendAsync(fixture, HttpMethod.Put, Path(id), save);
        await Assert.That(oldRetry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await oldRetry.Content.ReadAsStringAsync()).IsEqualTo(await saved.Content.ReadAsStringAsync());
        await Assert.That((await ReadAsync(fixture, id)).Revision).IsEqualTo(3L);
        using var assigned = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/assignments"), Assignments(3, [], [actor]));
        await MetadataAsync(assigned, HttpStatusCode.OK, 4);
        await Assert.That((await ReadAsync(fixture, id)).DocumentJson).IsEqualTo(before.DocumentJson);
        using var assignedRetry = await SendAsync(fixture, HttpMethod.Put, Path(id), save);
        await Assert.That(assignedRetry.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await assignedRetry.Content.ReadAsStringAsync()).IsEqualTo(await saved.Content.ReadAsStringAsync());
        await Assert.That((await ReadAsync(fixture, id)).Revision).IsEqualTo(4L);
        using var resumed = await SendAsync(fixture, HttpMethod.Put, Path(id), Save(id, "After reopen", 4));
        await Assert.That(resumed.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var replace = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/assignments"), Assignments(5, [], [actor]));
        await MetadataAsync(replace, HttpStatusCode.OK, 6);
        await Assert.That((await ReadAsync(fixture, id)).LastMutationId is null).IsTrue();
    }

    [Test]
    [Arguments("archive")]
    [Arguments("assignments")]
    public async Task ProjectLifecycle_ClassMetadataChangesInvalidateApprovalWithoutRewritingEvidence(string operation)
    {
        await using var fixture = await ReviewSubmissionEndpointTests.CreateFixtureAsync(new ReviewSubmissionEndpointTests.FixtureAssets());
        var data = await ReviewSubmissionEndpointTests.SeedAsync(fixture, false);
        var submissionId = Guid.NewGuid();
        using (var submitted = await ReviewSubmissionEndpointTests.SubmitAsync(fixture, data.ProjectId, submissionId, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        await fixture.SignInAsync(data.Educator);
        var detailPath = Path(data.ProjectId, $"/submissions/{submissionId:D}");
        using (var approved = await SendAsync(fixture, HttpMethod.Post, detailPath + "/decisions",
            new { decisionId = Guid.NewGuid(), expectedRevision = 0, outcome = "approved", feedback = "Retain this review" }))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var beforeResponse = await fixture.Client.GetAsync(detailPath);
        await Assert.That(beforeResponse.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var before = await beforeResponse.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(before.GetProperty("isCurrentSubmission").GetBoolean()).IsTrue();
        await Assert.That(await ApprovalAsync()).IsEqualTo(ReviewApprovalState.Approved);

        using (var changed = await SendAsync(fixture, HttpMethod.Patch, Path(data.ProjectId, "/" + operation),
            operation == "archive" ? new { expectedRevision = 0, archived = true } : Assignments(0, [], [data.Educator])))
        { await MetadataAsync(changed, HttpStatusCode.OK, 1); }
        await Assert.That(await ApprovalAsync()).IsEqualTo(operation == "archive"
            ? ReviewApprovalState.StaleProject : ReviewApprovalState.ApprovalRequired);
        using (var restored = await SendAsync(fixture, HttpMethod.Patch, Path(data.ProjectId, "/" + operation),
            operation == "archive" ? new { expectedRevision = 1, archived = false } : Assignments(1, [data.Student], [data.Educator])))
        { await MetadataAsync(restored, HttpStatusCode.OK, 2); }
        await Assert.That(await ApprovalAsync()).IsEqualTo(ReviewApprovalState.ApprovalRequired);

        using var afterResponse = await fixture.Client.GetAsync(detailPath);
        await Assert.That(afterResponse.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var after = await afterResponse.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(after.GetProperty("isCurrentSubmission").GetBoolean()).IsFalse();
        foreach (var field in before.EnumerateObject().Where(field => field.Name != "isCurrentSubmission"))
        {
            await Assert.That(JsonElement.DeepEquals(field.Value, after.GetProperty(field.Name))).IsTrue();
        }
        await fixture.SignInAsync(data.Student);
        var reopened = await OpenAsync(fixture, data.ProjectId);
        await Assert.That(reopened.GetProperty("revision").GetInt64()).IsEqualTo(2L);
        await Assert.That(JsonElement.DeepEquals(before.GetProperty("document"), reopened.GetProperty("document"))).IsTrue();
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        var stored = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await stored.ReviewSubmissions.CountAsync()).IsEqualTo(1);
        await Assert.That(await stored.ReviewDecisions.CountAsync()).IsEqualTo(1);
        await Assert.That((await stored.ClassAssignmentStudents.SingleAsync(row => row.ProjectId == data.ProjectId)).StudentId)
            .IsEqualTo(data.Student);
        var provenance = await stored.ProjectProvenances.SingleAsync(row => row.ProjectId == data.ProjectId);
        await Assert.That(provenance.Kind).IsEqualTo(ProjectProvenance.Class);
        await Assert.That(provenance.StudentId).IsEqualTo(data.Student);

        async Task<ReviewApprovalState> ApprovalAsync()
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            var project = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == data.ProjectId);
            var snapshot = new ProjectAccessSnapshot(data.Educator, project.Id, project.OrganizationId, project.IsArchived,
                project.Revision, project.SchemaVersion, project.DocumentJson, project.UpdatedAt,
                null, null, null, !project.IsArchived, true, !project.IsArchived);
            return await ReviewApproval.CheckLockedAsync(database, snapshot);
        }
    }

    [Test]
    public async Task ProjectLifecycle_InvalidAssignmentsAndUnauthorizedIdsCannotChangeOrRevealProjects()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var owner = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var foreign = await fixture.CreateAccountAsync();
        var student = await fixture.CreateAccountAsync();
        var disabled = await fixture.CreateAccountAsync();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var org = await database.OrganizationMemberships.Where(row => row.UserId == owner).Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == student || row.UserId == disabled)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, org));
            await database.Users.Where(row => row.Id == disabled).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        }
        await fixture.SignInAsync(owner);
        var id = await CreateAsync(fixture, new { title = Marker, environmentAssetId = "test-room-v1" });
        var before = await ReadAsync(fixture, id);
        foreach (var body in new[] { Assignments(0, [foreign]), Assignments(0, [disabled]), Assignments(0, [owner]), Assignments(0, [], [student]), Assignments(0, [Guid.NewGuid()]) })
        {
            using var rejected = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/assignments"), body);
            await ProblemAsync(fixture, rejected, HttpStatusCode.UnprocessableEntity, "invalid_project_assignments");
        }
        foreach (var body in new[] { Assignments(0, [student, student]), Assignments(0, [], publish: [student]), Assignments(0, [Guid.Empty]), Assignments(0, [student], [student]) })
        {
            using var rejected = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/assignments"), body);
            await ProblemAsync(fixture, rejected, HttpStatusCode.BadRequest, "invalid_project_input");
        }
        using var assigned = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/assignments"), Assignments(0, [student], [owner]));
        await MetadataAsync(assigned, HttpStatusCode.OK, 1);
        using var studentClient = fixture.CreateClient();
        await fixture.SignInAsync(student, studentClient);
        foreach (var suffix in new[] { "/assignments", "/archive" })
        {
            using var forbidden = await SendAsync(fixture, HttpMethod.Patch, Path(id, suffix), suffix == "/archive" ? new { expectedRevision = 1, archived = true } : Assignments(1, [student]), studentClient);
            await ProblemAsync(fixture, forbidden, HttpStatusCode.Forbidden, "access_denied");
        }
        using var foreignClient = fixture.CreateClient();
        await fixture.SignInAsync(foreign, foreignClient);
        foreach (var hidden in new[] { id, Guid.NewGuid() })
        {
            foreach (var suffix in new[] { "/duplicate", "/assignments", "/archive" })
            {
                object body = suffix == "/duplicate" ? new { expectedRevision = 1, title = "Copy" }
                    : suffix == "/archive" ? new { expectedRevision = 1, archived = true } : Assignments(1, [foreign]);
                using var denied = await SendAsync(fixture, suffix == "/duplicate" ? HttpMethod.Post : HttpMethod.Patch, Path(hidden, suffix), body, foreignClient);
                await ProblemAsync(fixture, denied, HttpStatusCode.NotFound, "project_not_found");
            }
        }
        var after = await ReadAsync(fixture, id);
        await Assert.That(after.DocumentJson).IsEqualTo(before.DocumentJson);
        await Assert.That(after.Revision).IsEqualTo(1L);
        await Assert.That(after.IsArchived).IsFalse();
    }

    [Test]
    public async Task ProjectLifecycle_CreateRejectsUntrustedInputBeforeInsertingAnything()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(actor);
        var document = ProjectTestDocuments.Create(Guid.NewGuid(), Marker);
        foreach (var (body, status, code) in new[]
        {
            ("{", HttpStatusCode.BadRequest, "invalid_request"),
            ("{}", HttpStatusCode.BadRequest, "invalid_request"),
            ("{\"title\":\"A\",\"title\":\"B\",\"environmentAssetId\":\"test-room-v1\"}", HttpStatusCode.BadRequest, "invalid_request"),
            ("{\"title\":\"A\",\"ownerId\":\"" + actor + "\",\"environmentAssetId\":\"test-room-v1\"}", HttpStatusCode.BadRequest, "invalid_request"),
            ("{\"title\":null,\"environmentAssetId\":\"test-room-v1\"}", HttpStatusCode.BadRequest, "invalid_project_input"),
            ("{\"title\":\" \"}", HttpStatusCode.BadRequest, "invalid_project_input"),
            ("{\"title\":\"A\",\"environmentAssetId\":\"test-room-v1\",\"document\":" + document + "}", HttpStatusCode.BadRequest, "invalid_project_input"),
            ("{\"title\":\"A\",\"document\":{\"permissions\":{}," + document[1..] + "}", HttpStatusCode.UnprocessableEntity, "invalid_document"),
            ("{\"title\":\"A\",\"environmentAssetId\":\"not-approved\"}", HttpStatusCode.UnprocessableEntity, "invalid_document"),
            ("{\"title\":\"A\",\"environmentAssetId\":\"test-room-v1\",\"orgId\":\"" + Guid.NewGuid() + "\"}", HttpStatusCode.Forbidden, "access_denied"),
            ("{\"title\":\"A\",\"document\":" + document.Replace(Marker, new string('x', 5 * 1024 * 1024), StringComparison.Ordinal) + "}", HttpStatusCode.UnprocessableEntity, "invalid_document"),
            ("{\"title\":\"" + new string('x', 6 * 1024 * 1024) + "\"}", HttpStatusCode.RequestEntityTooLarge, "request_too_large")
        })
        {
            using var response = await SendRawAsync(fixture, HttpMethod.Post, "/api/v1/projects", body);
            await ProblemAsync(fixture, response, status, code);
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.ProjectAssignments.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments("create")]
    [Arguments("duplicate")]
    [Arguments("assignments")]
    [Arguments("archive")]
    public async Task ProjectLifecycle_FailedCommitRollsBackTheEntireOperation(string operation)
    {
        var probe = new CommitFailure();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var id = await CreateAsync(fixture, new { title = Marker, environmentAssetId = "test-room-v1" });
        var before = await ReadAsync(fixture, id);
        var csrf = await fixture.GetCsrfAsync();
        probe.Armed = true;
        object body = operation switch
        {
            "create" => new { title = "Failed", environmentAssetId = "test-room-v1" },
            "duplicate" => new { expectedRevision = 0, title = "Failed" },
            "assignments" => Assignments(0, []),
            _ => new { expectedRevision = 0, archived = true }
        };
        using var response = await SendAsync(fixture, operation is "create" or "duplicate" ? HttpMethod.Post : HttpMethod.Patch,
            operation == "create" ? "/api/v1/projects" : Path(id, "/" + operation), body, token: csrf);
        await ProblemAsync(fixture, response, HttpStatusCode.ServiceUnavailable, "storage_unavailable");
        var after = await ReadAsync(fixture, id);
        await Assert.That(after.DocumentJson).IsEqualTo(before.DocumentJson);
        await Assert.That(after.UpdatedAt).IsEqualTo(before.UpdatedAt);
        await Assert.That(after.Revision).IsEqualTo(0L);
        await Assert.That(after.IsArchived).IsFalse();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That((await database.ProjectAssignments.SingleAsync()).UserId).IsEqualTo(actor);
    }

    [Test]
    [Arguments("assignments", false)]
    [Arguments("assignments", true)]
    [Arguments("archive", false)]
    [Arguments("archive", true)]
    public async Task ProjectLifecycle_SaveAndMetadataRacesUseOneLockAndPreserveTheWinner(string operation, bool saveFirst)
    {
        var commit = new CommitPause();
        var locks = new LockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, locks)), environmentName: "Development");
        var owner = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == owner).Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == student).ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
        }
        await fixture.SignInAsync(owner);
        var id = await CreateAsync(fixture, new { title = "Original", environmentAssetId = "test-room-v1" });
        using var assigned = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/assignments"), Assignments(0, [student], [owner]));
        await MetadataAsync(assigned, HttpStatusCode.OK, 1);
        using var studentClient = fixture.CreateClient();
        await fixture.SignInAsync(student, studentClient);
        var ownerToken = await fixture.GetCsrfAsync();
        var studentToken = await fixture.GetCsrfAsync(studentClient);
        object metadataBody = operation == "archive" ? new { expectedRevision = 1, archived = true } : Assignments(1, [], [owner]);
        Task<HttpResponseMessage> SaveRequest() => SendAsync(fixture, HttpMethod.Put, Path(id), Save(id, Marker, 1), studentClient, studentToken);
        Task<HttpResponseMessage> MetadataRequest() => SendAsync(fixture, HttpMethod.Patch, Path(id, "/" + operation), metadataBody, token: ownerToken);
        commit.Armed = true;
        var first = saveFirst ? SaveRequest() : MetadataRequest();
        Task<HttpResponseMessage>? second = null;
        try
        {
            var holder = await commit.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            locks.Armed = true;
            second = saveFirst ? MetadataRequest() : SaveRequest();
            var waiter = await locks.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(fixture, waiter, holder);
            commit.Release.TrySetResult();
            using var winner = await first;
            using var loser = await second;
            await Assert.That(winner.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await ProblemAsync(fixture, loser,
                saveFirst ? HttpStatusCode.Conflict : operation == "archive" ? HttpStatusCode.Forbidden : HttpStatusCode.NotFound,
                saveFirst ? "revision_conflict" : operation == "archive" ? "project_read_only" : "project_not_found", saveFirst ? 2 : null);
            var persisted = await ReadAsync(fixture, id);
            await Assert.That(persisted.Revision).IsEqualTo(2L);
            await Assert.That(persisted.IsArchived).IsEqualTo(!saveFirst && operation == "archive");
            using var body = JsonDocument.Parse(persisted.DocumentJson);
            await Assert.That(body.RootElement.GetProperty("title").GetString()).IsEqualTo(saveFirst ? Marker : "Original");
            await Assert.That(persisted.LastMutationId is not null).IsEqualTo(saveFirst);
        }
        finally
        {
            commit.Release.TrySetResult();
            using var drainedFirst = await first;
            if (second is not null) { using var drainedSecond = await second; }
        }
    }

    [Test]
    public async Task ProjectLifecycle_MetadataRejectsExhaustedOrMalformedRevisionsWithoutChangingState()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var id = await CreateAsync(fixture, new { title = Marker, environmentAssetId = "test-room-v1" });
        foreach (var body in new[] { "{}", "{\"expectedRevision\":0}", "{\"expectedRevision\":\"0\",\"archived\":true}",
            "{\"expectedRevision\":0,\"expectedRevision\":1,\"archived\":true}", "{\"expectedRevision\":0,\"archived\":null}",
            "{\"expectedRevision\":0,\"archived\":true,\"owner\":true}" })
        {
            using var rejected = await SendRawAsync(fixture, HttpMethod.Patch, Path(id, "/archive"), body);
            await ProblemAsync(fixture, rejected, HttpStatusCode.BadRequest, "invalid_request");
        }
        using var negative = await SendAsync(fixture, HttpMethod.Patch, Path(id, "/archive"), new { expectedRevision = -1, archived = true });
        await ProblemAsync(fixture, negative, HttpStatusCode.BadRequest, "invalid_project_input");
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, Project.MaxRevision));
        }
        foreach (var suffix in new[] { "/archive", "/assignments" })
        {
            using var exhausted = await SendAsync(fixture, HttpMethod.Patch, Path(id, suffix), suffix == "/archive"
                ? new { expectedRevision = Project.MaxRevision, archived = true } : Assignments(Project.MaxRevision, [], [actor]));
            await ProblemAsync(fixture, exhausted, HttpStatusCode.Conflict, "revision_exhausted", Project.MaxRevision);
        }
        var source = await ReadAsync(fixture, id);
        await Assert.That(source.IsArchived).IsFalse();
        await Assert.That(source.Revision).IsEqualTo(Project.MaxRevision);
        using var duplicate = await SendAsync(fixture, HttpMethod.Post, Path(id, "/duplicate"), new { expectedRevision = Project.MaxRevision, title = "Fresh copy" });
        await MetadataAsync(duplicate, HttpStatusCode.Created, 0);
    }

    [Test]
    public async Task ProjectLifecycle_AllWritesRequireFullAccountAndCsrf()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var forced = await fixture.CreateAccountAsync(forced: true);
        var active = await fixture.CreateAccountAsync();
        using var forcedClient = fixture.CreateClient();
        using var activeClient = fixture.CreateClient();
        await fixture.SignInAsync(forced, forcedClient);
        await fixture.SignInAsync(active, activeClient);
        var id = Guid.NewGuid();
        foreach (var (method, path, body) in new[]
        {
            (HttpMethod.Post, "/api/v1/projects", (object)new { title = "New", environmentAssetId = "test-room-v1" }),
            (HttpMethod.Post, Path(id, "/duplicate"), new { expectedRevision = 0, title = "New" }),
            (HttpMethod.Patch, Path(id, "/archive"), new { expectedRevision = 0, archived = true }),
            (HttpMethod.Patch, Path(id, "/assignments"), Assignments(0, []))
        })
        {
            using var anonymous = await SendAsync(fixture, method, path, body);
            await ProblemAsync(fixture, anonymous, HttpStatusCode.Unauthorized, "authentication_required");
            using var restricted = await SendAsync(fixture, method, path, body, forcedClient);
            await ProblemAsync(fixture, restricted, HttpStatusCode.Forbidden, "access_denied");
            using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body) };
            using var noCsrf = await activeClient.SendAsync(request);
            await ProblemAsync(fixture, noCsrf, HttpStatusCode.BadRequest, "csrf_invalid");
        }
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ProjectLifecycle_ExpiredSessionOrInsertFailureCannotAcknowledgeOrLeaveAPartialCreation(bool storageFailure)
    {
        var save = new SaveProbe();
        var insert = new InsertFailure();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(save, insert)), environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var token = await fixture.GetCsrfAsync();
        insert.Armed = storageFailure;
        if (!storageFailure) { save.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9)); }
        using var response = await SendAsync(fixture, HttpMethod.Post, "/api/v1/projects", new { title = Marker, environmentAssetId = "test-room-v1" }, token: token);
        await ProblemAsync(fixture, response, storageFailure ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.Unauthorized,
            storageFailure ? "storage_unavailable" : "authentication_required");
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.ProjectAssignments.CountAsync()).IsEqualTo(0);
    }

    private static string Path(Guid id, string suffix = "") => "/api/v1/projects/" + id.ToString("D") + suffix;
    private static object Assignments(long revision, Guid[] creators, Guid[]? managers = null, Guid[]? publish = null) =>
        new { expectedRevision = revision, managedByUserIds = managers ?? [], assignedCreatorIds = creators, canPublishUserIds = publish ?? [] };
    private static object Save(Guid id, string title, long revision, int version = 1)
    {
        using var document = JsonDocument.Parse(ProjectTestDocuments.Create(id, title, version));
        return new { expectedRevision = revision, clientMutationId = Guid.NewGuid(), document = document.RootElement.Clone() };
    }

    private static async Task<Guid> CreateAsync(HttpsApplicationFixture fixture, object body)
    {
        using var response = await SendAsync(fixture, HttpMethod.Post, "/api/v1/projects", body);
        return (await MetadataAsync(response, HttpStatusCode.Created, 0)).GetProperty("projectId").GetGuid();
    }
    private static async Task<Guid> OrganizationAsync(HttpsApplicationFixture fixture, Guid actor)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var membership = await database.OrganizationMemberships.SingleOrDefaultAsync(row => row.UserId == actor);
        if (membership is not null) { return membership.OrganizationId; }
        var organization = new Organization { Id = Guid.NewGuid(), Name = "Class" };
        database.Organizations.Add(organization);
        await database.SaveChangesAsync();
        return organization.Id;
    }
    private static async Task<Project> ReadAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.AsNoTracking().SingleAsync(row => row.Id == id);
    }
    private static async Task<JsonElement> OpenAsync(HttpsApplicationFixture fixture, Guid id, HttpClient? client = null)
    {
        using var response = await (client ?? fixture.Client).GetAsync(Path(id));
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }
    private static async Task<HttpResponseMessage> SendAsync(HttpsApplicationFixture fixture, HttpMethod method,
        string path, object body, HttpClient? client = null, string? token = null)
    {
        using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body) };
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await (client ?? fixture.Client).SendAsync(request);
    }
    private static async Task<HttpResponseMessage> SendRawAsync(HttpsApplicationFixture fixture, HttpMethod method, string path, string body)
    {
        using var request = new HttpRequestMessage(method, path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.ExpectContinue = true;
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }
    private static async Task<JsonElement> MetadataAsync(HttpResponseMessage response, HttpStatusCode status, long revision)
    {
        await Assert.That(response.StatusCode).IsEqualTo(status);
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(body.EnumerateObject().Select(field => field.Name).Order().SequenceEqual(new[] { "archived", "projectId", "revision", "updatedAt" })).IsTrue();
        await Assert.That(body.GetProperty("revision").GetInt64()).IsEqualTo(revision);
        await Assert.That(body.GetProperty("updatedAt").GetDateTimeOffset().Offset).IsEqualTo(TimeSpan.Zero);
        return body;
    }
    private static async Task ProblemAsync(HttpsApplicationFixture fixture, HttpResponseMessage response, HttpStatusCode status, string code, long? revision = null)
    {
        await AuthTestRequests.AssertProblemAsync(response, status, code);
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(body.EnumerateObject().Select(field => field.Name).Order().SequenceEqual(
            new[] { "type", "title", "status", "code", "traceId" }.Concat(revision is null ? [] : new[] { "currentRevision" }).Order())).IsTrue();
        if (revision is not null) { await Assert.That(body.GetProperty("currentRevision").GetInt64()).IsEqualTo(revision.Value); }
        await Assert.That(body.GetRawText().Contains(Marker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(Marker, StringComparison.Ordinal)).IsFalse();
    }
    private sealed class CommitFailure : DbTransactionInterceptor
    {
        public bool Armed { get; set; }
        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed) { Armed = false; throw new NpgsqlException(Marker); }
            return ValueTask.FromResult(result);
        }
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
    private sealed class LockProbe : DbCommandInterceptor
    {
        public bool Armed { get; set; }
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal))
            {
                Armed = false;
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }
    private sealed class SaveProbe : SaveChangesInterceptor
    {
        public Action? After;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }
    private sealed class InsertFailure : DbCommandInterceptor
    {
        public bool Armed { get; set; }
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("INSERT INTO projects", StringComparison.Ordinal))
            {
                Armed = false;
                throw new NpgsqlException(Marker);
            }
            return ValueTask.FromResult(result);
        }
    }
}
