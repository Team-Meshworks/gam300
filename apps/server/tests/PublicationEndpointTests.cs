using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(PublicationEndpointTests))]
public sealed class PublicationEndpointTests
{
    [Test]
    [Arguments("Public")]
    [Arguments("Unlisted")]
    public async Task StudentPublishesApprovedRevisionAndSharesWithoutGrantingDraftAccess(string audience)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        const long revision = 291;
        var (data, asset) = await PrepareAsync(fixture, approve: false, revision: revision);

        // Upgrade an existing assignment that predates student publishing
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.ProjectAssignments.Where(row => row.ProjectId == data.ProjectId && row.UserId == data.Student)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.CanPublish, false));
            var migrations = database.GetService<IMigrator>();
            await migrations.MigrateAsync("20261108003114_AddAssignmentEditing");
            await migrations.MigrateAsync();
            await Assert.That((await database.ProjectAssignments.SingleAsync(row => row.ProjectId == data.ProjectId && row.UserId == data.Student)).CanPublish).IsFalse();
        }
        await fixture.SignInAsync(data.Student);
        using (var denied = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid(), audience, revision: revision))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }

        // Only an educator may approve the student's submitted saved revision
        Guid submission;
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            submission = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ReviewSubmissions
                .Where(row => row.ProjectId == data.ProjectId).Select(row => row.Id).SingleAsync();
        }
        var decision = new { decisionId = Guid.NewGuid(), expectedRevision = revision, outcome = "approved", feedback = "Ready to share" };
        async Task<HttpResponseMessage> Approve()
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{data.ProjectId}/submissions/{submission}/decisions")
            { Content = JsonContent.Create(decision) };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            return await fixture.Client.SendAsync(request);
        }
        using (var selfApproval = await Approve())
        { await Assert.That(selfApproval.IsSuccessStatusCode).IsFalse(); }
        await fixture.SignInAsync(data.Educator);
        using (var approved = await Approve())
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }

        if (audience == "Public")
        {
            // Reproduce an approval saved before it also enabled student publishing
            await using var scope = fixture.App.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.ProjectAssignments.Where(row => row.ProjectId == data.ProjectId && row.UserId == data.Student)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.CanPublish, false));
            await database.GetService<IMigrator>().MigrateAsync("20261108160000_AddAccountDeletion");
            await database.GetService<IMigrator>().MigrateAsync();
        }

        // Students publish; friends can read only the immutable edition and its pinned assets
        await fixture.SignInAsync(data.Student);
        var id = Guid.NewGuid();
        using (var published = await PublishAsync(fixture, data.ProjectId, id, audience, revision: revision))
        { await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var friend = fixture.CreateClient();
        using var snapshot = await friend.GetAsync($"/api/v1/publications/{id}");
        await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var original = await snapshot.Content.ReadAsStringAsync();
        using var bytes = await friend.GetAsync($"/api/v1/publications/{id}/assets/{asset.Id:D}/bytes");
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var privateDraft = await friend.GetAsync($"/api/v1/projects/{data.ProjectId}");
        await Assert.That(privateDraft.IsSuccessStatusCode).IsFalse();

        // Saving another revision requires new approval while the already shared edition stays unchanged
        using var read = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}");
        var saved = (await read.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("document");
        var document = JsonNode.Parse(saved.GetRawText())!;
        document["title"] = "Edited after approval";
        using var save = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/projects/{data.ProjectId}")
        { Content = JsonContent.Create(new { expectedRevision = revision, clientMutationId = Guid.NewGuid(), document }) };
        save.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using (var changed = await fixture.Client.SendAsync(save))
        { await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var denied = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid(), audience, revision: revision + 1))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        using var unchanged = await friend.GetAsync($"/api/v1/publications/{id}");
        await Assert.That(await unchanged.Content.ReadAsStringAsync()).IsEqualTo(original);
    }

    [Test]
    public async Task StudentPublicationUpgradePreservesRevokedPermission()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);

        // Revoke the student grant through the same revisioned API used by project managers
        using (var request = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/projects/{data.ProjectId}/assignments"))
        {
            request.Content = JsonContent.Create(new
            {
                expectedRevision = 0,
                managedByUserIds = new[] { data.Educator },
                assignedCreatorIds = new[] { data.Student },
                canPublishUserIds = Array.Empty<Guid>()
            });
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var revoked = await fixture.Client.SendAsync(request);
            await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.OK);
        }

        // Rewind only after the API change; the current binary requires the latest account schema
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.GetService<IMigrator>().MigrateAsync("20261108003114_AddAssignmentEditing");
        }

        // Applying the upgrade must not undo a manager's explicit permission change
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.GetService<IMigrator>().MigrateAsync();
            var grant = await database.ProjectAssignments.AsNoTracking()
                .SingleAsync(row => row.ProjectId == data.ProjectId && row.UserId == data.Student);
            await Assert.That(grant.CanPublish).IsFalse();
        }
        await fixture.SignInAsync(data.Student);
        using var denied = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid(), revision: 1);
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
    }

    [Test]
    public async Task DashboardLinks_PageVisibleProjectsAndRecheckAudienceAndGrants()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var publicationId = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, publicationId, viewers: [data.Student]);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var privateEdition = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid());
        await Assert.That(privateEdition.StatusCode).IsEqualTo(HttpStatusCode.Created);
        const string path = "/api/v1/projects/publication-links?limit=1";
        using var educator = await fixture.Client.GetAsync(path);
        await Assert.That(educator.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var source = await database.Projects.SingleAsync(row => row.Id != data.ProjectId);
        var otherEdition = Guid.NewGuid();
        database.Publications.Add(new Publication
        {
            Id = otherEdition,
            ProjectId = source.Id,
            PublishedById = data.Educator,
            SourceRevision = source.Revision,
            SchemaVersion = source.SchemaVersion,
            DocumentJson = source.DocumentJson,
            AssetReferencesJson = "[]",
            RequestDigest = new byte[32]
        });
        database.PublicationAccess.Add(new PublicationAccessState { PublicationId = otherEdition, Audience = (int)PublicationAudience.Public });
        var grant = new ProjectAssignment { ProjectId = source.Id, UserId = data.Student, CanEdit = true };
        database.ProjectAssignments.Add(grant);
        await database.SaveChangesAsync();
        await fixture.SignInAsync(data.Student);
        var first = await fixture.Client.GetFromJsonAsync<JsonElement>(path);
        var cursor = first.GetProperty("nextCursor").GetGuid();
        var second = await fixture.Client.GetFromJsonAsync<JsonElement>($"{path}&cursor={cursor:D}");
        var ids = new[] { first, second }.Select(page => page.GetProperty("items").EnumerateArray().Single())
            .ToDictionary(item => item.GetProperty("projectId").GetGuid(), item => item.GetProperty("publicationId").GetGuid());
        await Assert.That(ids[data.ProjectId]).IsEqualTo(publicationId);
        await Assert.That(ids[source.Id]).IsEqualTo(otherEdition);
        await Assert.That(second.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        var legacy = await fixture.Client.GetFromJsonAsync<JsonElement>($"/api/v1/projects/{data.ProjectId}/publication-links?view=dashboard");
        await Assert.That(legacy.GetProperty("items").EnumerateArray().Single().GetProperty("publicationId").GetGuid()).IsEqualTo(publicationId);
        database.ProjectAssignments.Remove(grant);
        await database.SaveChangesAsync();
        var retry = await fixture.Client.GetFromJsonAsync<JsonElement>(path);
        await Assert.That(retry.GetProperty("items").EnumerateArray().Single().GetProperty("publicationId").GetGuid()).IsEqualTo(publicationId);
        await Assert.That(retry.GetProperty("nextCursor").ValueKind).IsEqualTo(JsonValueKind.Null);
        var access = await database.PublicationAccess.SingleAsync(row => row.PublicationId == publicationId);
        access.ViewerIds = [];
        await database.SaveChangesAsync();
        var denied = await fixture.Client.GetFromJsonAsync<JsonElement>(path);
        await Assert.That(denied.GetProperty("items").GetArrayLength()).IsEqualTo(0);
    }

    [Test]
    public async Task EducatorOverride_PublishesAndReplaysApprovedAssignment()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        async Task<HttpResponseMessage> Publish(long revision)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{data.ProjectId}/publications")
            {
                Content = JsonContent.Create(new
                {
                    publicationId = id,
                    confirmedRevision = revision,
                    intent = new { audience = "Unlisted", viewerIds = Array.Empty<Guid>(), teacherOverride = true }
                })
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            return await fixture.Client.SendAsync(request);
        }
        using var created = await Publish(0);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var replay = await Publish(0);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var conflict = await Publish(1);
        await Assert.That(conflict.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
    }
    [Test]
    public async Task PublishedAssignment_EditingDetailsKeepsPublishedSnapshotAndOriginalSubmissionDeadline()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var publicationId = Guid.NewGuid();
        using (var published = await PublishAsync(fixture, data.ProjectId, publicationId, audience: "Unlisted"))
        { await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var visitor = fixture.CreateClient();
        using var original = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}");
        var originalBody = await original.Content.ReadAsStringAsync();
        Guid assignmentId;
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            assignmentId = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ClassAssignments.Select(row => row.Id).SingleAsync();
        }
        using var edit = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/classes/{data.ClassroomId:D}/assignments/{assignmentId:D}")
        {
            Content = JsonContent.Create(new
            {
                mutationId = Guid.NewGuid(),
                expectedRevision = 0,
                title = "Changed title",
                description = "Changed description",
                instructions = "Changed instructions",
                dueAtUnixSeconds = data.Due + 3600,
                studentIds = new[] { data.Student }
            })
        };
        edit.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using (var changed = await fixture.Client.SendAsync(edit))
        { await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using var after = await visitor.GetAsync($"/api/v1/publications/{publicationId:D}");
        await Assert.That(await after.Content.ReadAsStringAsync()).IsEqualTo(originalBody);
        using var detail = await fixture.Client.GetAsync($"/api/v1/classes/{data.ClassroomId:D}/assignments/{assignmentId:D}");
        var item = (await detail.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects")[0];
        await Assert.That(item.GetProperty("published").GetBoolean()).IsTrue();
        await Assert.That(item.GetProperty("approvalStatus").GetString()).IsEqualTo("changes-since-submission");
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var database = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await database.ReviewSubmissions.SingleAsync(row => row.ProjectId == data.ProjectId)).DueAtUnixSeconds).IsEqualTo(data.Due);
    }

    [Test]
    public async Task PublicationLinks_StudentCanFindCurrentUnlistedLinkWithoutExposingOtherProjects()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, id, audience: "Unlisted");
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        Guid assignmentId;
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            assignmentId = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().ClassAssignments.Select(row => row.Id).SingleAsync();
        }
        async Task<JsonElement> AssignmentStudent()
        {
            using var response = await fixture.Client.GetAsync($"/api/v1/classes/{data.ClassroomId:D}/assignments/{assignmentId:D}");
            return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("projects")[0];
        }
        var beforeRevocation = await AssignmentStudent();
        await Assert.That(beforeRevocation.GetProperty("published").GetBoolean()).IsTrue();
        await Assert.That(beforeRevocation.GetProperty("approvalStatus").GetString()).IsEqualTo("approved");
        await fixture.SignInAsync(data.Student);
        using var links = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-links");
        await Assert.That(links.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var body = await links.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(body.GetProperty("items").GetArrayLength()).IsEqualTo(1);
        await Assert.That(body.GetProperty("items")[0].GetProperty("visitorUrl").GetString()).IsEqualTo($"https://publications.example.test/p/{id:D}");
        await fixture.SignInAsync(data.OtherStudent);
        using var denied = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-links");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await fixture.SignInAsync(data.Educator);
        using var revoke = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{id}/access")
        { Content = JsonContent.Create(new { audience = "Unlisted", viewerIds = Array.Empty<Guid>(), action = "revoke" }) };
        revoke.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var revoked = await fixture.Client.SendAsync(revoke);
        await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That((await AssignmentStudent()).GetProperty("published").GetBoolean()).IsFalse();
        await fixture.SignInAsync(data.Student);
        using var after = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-links");
        await Assert.That((await after.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0);
    }

    [Test]
    [Arguments("Unlisted")]
    [Arguments("Public")]
    public async Task Publish_AnonymousEditionAllowsAnonymousReadAndRespectsRevocation(string audience)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, asset) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, id, audience: audience);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var anonymous = fixture.CreateClient();
        using var snapshot = await anonymous.GetAsync($"/api/v1/publications/{id}");
        using var manifest = await anonymous.GetAsync($"/api/v1/publications/{id}/manifest");
        using var bytes = await anonymous.GetAsync($"/api/v1/publications/{id}/assets/{asset.Id:D}/bytes");
        await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(manifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await bytes.Content.ReadAsByteArrayAsync()).SequenceEqual(asset.Bytes)).IsTrue();
        using var draft = await anonymous.GetAsync($"/api/v1/projects/{data.ProjectId}");
        await Assert.That(draft.IsSuccessStatusCode).IsFalse();
        using var replay = await PublishAsync(fixture, data.ProjectId, id, audience: audience);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var revoke = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{id}/access")
        {
            Content = JsonContent.Create(new { audience = audience, viewerIds = Array.Empty<Guid>(), action = "revoke" }),
        };
        revoke.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var revoked = await fixture.Client.SendAsync(revoke);
        await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var deniedSnapshot = await anonymous.GetAsync($"/api/v1/publications/{id}");
        using var deniedBytes = await anonymous.GetAsync($"/api/v1/publications/{id}/assets/{asset.Id:D}/bytes");
        await Assert.That(deniedSnapshot.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await Assert.That(deniedBytes.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var deniedReplay = await PublishAsync(fixture, data.ProjectId, id, audience: audience);
        await Assert.That(deniedReplay.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Publish_V2RetainsAudioHotspotsAndBothScenesWithEnabledOrDisabledRules(bool enabled)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture, content: true, enabledRule: enabled);
        string saved;
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            saved = (await database.Projects.SingleAsync(row => row.Id == data.ProjectId)).DocumentJson;
        }

        // Readiness and publication use the same capability decision for the confirmed revision
        using var readiness = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-readiness");
        var state = await readiness.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(state.GetProperty("state").GetString()).IsEqualTo("Ready");
        var missing = state.GetProperty("missingCapabilities");
        await Assert.That(missing.GetArrayLength()).IsEqualTo(0);
        var publication = Guid.NewGuid();
        using var response = await PublishAsync(fixture, data.ProjectId, publication);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var db = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await db.Projects.SingleAsync(row => row.Id == data.ProjectId)).DocumentJson).IsEqualTo(saved);
        await Assert.That(await db.Publications.CountAsync()).IsEqualTo(1);
        {
            // Fetch the immutable edition through the same route used by the visitor
            using var snapshot = await fixture.Client.GetAsync($"/api/v1/publications/{publication}");
            await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var published = await snapshot.Content.ReadAsStringAsync();
            await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(saved), JsonNode.Parse(published))).IsTrue();
            await Assert.That(JsonNode.Parse(published)!["scenes"]!.AsArray().Count).IsEqualTo(2);
            var track = JsonNode.Parse(published)!["scenes"]![0]!["audio"]![0]!["assetId"]!.GetValue<string>();
            using var audioResponse = await fixture.Client.GetAsync($"/api/v1/publications/{publication}/assets/{track}/bytes");
            await Assert.That(audioResponse.Content.Headers.ContentType!.MediaType).IsEqualTo("audio/mp4");
            var expected = await db.AssetCandidates.SingleAsync(item => item.Id == Guid.Parse(track));
            await Assert.That((await audioResponse.Content.ReadAsByteArrayAsync()).SequenceEqual(expected.Bytes)).IsTrue();
        }
    }

    [Test]
    public async Task Publish_UncapturedAudioUrlsAreRejectedBeforeCommitting()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture, interactions: true);
        await using (var edit = fixture.App.Services.CreateAsyncScope())
        {
            var db = edit.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var row = await db.Projects.SingleAsync(item => item.Id == data.ProjectId);
            var document = JsonNode.Parse(row.DocumentJson)!;
            document["scenes"]![0]!["interactions"]![0]!["do"] = JsonNode.Parse("""{"type":"play-audio","url":"https://example.com/track.m4a"}""");
            row.DocumentJson = document.ToJsonString();
            await db.SaveChangesAsync();
        }
        using var readiness = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-readiness");
        var state = await readiness.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(state.GetProperty("state").GetString()).IsEqualTo("UnsupportedRuntime");
        using var response = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid());
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.UnprocessableEntity);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(problem.GetProperty("code").GetString()).IsEqualTo("unsupported_publication_runtime");
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task PublicationViewers_OnlyCurrentPublishersCanPageEligibleOrganizationAccounts()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await database.ProjectAssignments.Where(row => row.ProjectId == data.ProjectId && row.UserId == data.Student)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.CanPublish, true));
        var foreign = await fixture.CreateAccountAsync();
        await fixture.SignInAsync(data.Student);
        using var roster = await fixture.Client.GetAsync($"/api/v1/classes/{data.ClassroomId}/roster");
        await Assert.That(roster.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        var viewers = new List<Guid>();
        string? cursor = null;
        do
        {
            using var response = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-viewers?limit=1" + (cursor is null ? "" : "&cursor=" + cursor));
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
            var page = await response.Content.ReadFromJsonAsync<JsonElement>();
            foreach (var item in page.GetProperty("items").EnumerateArray())
            {
                viewers.Add(item.GetProperty("userId").GetGuid());
                await Assert.That(string.IsNullOrWhiteSpace(item.GetProperty("userName").GetString())).IsFalse();
            }
            cursor = page.GetProperty("nextCursor").GetString();
            await Assert.That(viewers.Count <= 3).IsTrue();
        } while (cursor is not null);
        await Assert.That(viewers.Contains(data.OtherStudent)).IsTrue();
        await Assert.That(viewers.Contains(data.Educator)).IsTrue();
        await Assert.That(viewers.Contains(foreign)).IsFalse();
        await database.Users.Where(row => row.Id == data.OtherStudent).ExecuteUpdateAsync(set => set.SetProperty(row => row.MustChangePassword, true));
        using var restricted = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-viewers");
        var eligible = await restricted.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(eligible.GetProperty("items").EnumerateArray().Any(row => row.GetProperty("userId").GetGuid() == data.OtherStudent)).IsFalse();
        await database.ProjectAssignments.Where(row => row.ProjectId == data.ProjectId && row.UserId == data.Student)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.CanPublish, false));
        using var denied = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-viewers");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task PublishReadiness_ReportsSavedRevisionPrerequisitesWithoutCreatingAnEdition(bool approved)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture, approve: approved);
        using var response = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-readiness");
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(body.GetProperty("projectId").GetGuid()).IsEqualTo(data.ProjectId);
        await Assert.That(body.GetProperty("revision").GetInt64()).IsEqualTo(0);
        await Assert.That(body.GetProperty("state").GetString()).IsEqualTo(approved ? "Ready" : "ApprovalRequired");
        await Assert.That(body.GetProperty("completionConfirmed").GetBoolean()).IsTrue();
        await Assert.That(body.GetProperty("approved").GetBoolean()).IsEqualTo(approved);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(0);
        await database.Projects.Where(row => row.Id == data.ProjectId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 1));
        using var changed = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-readiness");
        var stale = await changed.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(stale.GetProperty("state").GetString()).IsEqualTo("ApprovalRequired");
        await Assert.That(stale.GetProperty("completionConfirmed").GetBoolean()).IsFalse();
        await Assert.That(stale.GetProperty("approved").GetBoolean()).IsFalse();
        await fixture.SignInAsync(data.OtherStudent);
        using var denied = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}/publication-readiness");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task Publish_ApprovedClassEditionCommitsPolicyBytesAndRetryWithoutChangingDraft()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, asset) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, id, viewers: [data.OtherStudent]);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var ack = await published.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(ack.GetProperty("publicationId").GetGuid()).IsEqualTo(id);
        await Assert.That(ack.GetProperty("sourceRevision").GetInt64()).IsEqualTo(0);
        await Assert.That(ack.GetProperty("visitorUrl").GetString()).IsEqualTo($"https://publications.example.test/p/{id:D}");
        var snapshotUrl = ack.GetProperty("snapshotUrl").GetString()!;
        await Assert.That(snapshotUrl).IsEqualTo($"https://publications.example.test/api/v1/publications/{id:D}");
        await Assert.That(published.Headers.Location?.AbsoluteUri).IsEqualTo(snapshotUrl);
        using var manifest = await fixture.Client.GetAsync($"/api/v1/publications/{id}/manifest");
        await Assert.That(manifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var manifestBody = await manifest.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(manifestBody.GetProperty("assets")[0].GetProperty("id").GetString()).IsEqualTo(asset.Id.ToString("D"));
        await Assert.That(manifestBody.GetProperty("assets")[0].GetProperty("sha256").GetString()).IsEqualTo(asset.Sha256);
        using var snapshot = await fixture.Client.GetAsync(new Uri(snapshotUrl).PathAndQuery);
        await Assert.That(snapshot.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var original = await snapshot.Content.ReadAsStringAsync();
        var assetUrl = manifestBody.GetProperty("assets")[0].GetProperty("url").GetString()!;
        await Assert.That(assetUrl).IsEqualTo($"/api/v1/publications/{id}/assets/{asset.Id}/bytes");
        using var bytes = await fixture.Client.GetAsync(assetUrl);
        await Assert.That(bytes.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That((await bytes.Content.ReadAsByteArrayAsync()).SequenceEqual(asset.Bytes)).IsTrue();
        using var replay = await PublishAsync(fixture, data.ProjectId, id, viewers: [data.OtherStudent]);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var replayAck = await replay.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(replayAck.GetProperty("snapshotUrl").GetString()).IsEqualTo(snapshotUrl);
        await fixture.SignInAsync(data.OtherStudent);
        using var named = await fixture.Client.GetAsync($"/api/v1/publications/{id}");
        await Assert.That(named.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var namedManifest = await fixture.Client.GetAsync($"/api/v1/publications/{id}/manifest");
        await Assert.That(namedManifest.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(namedManifest.Headers.CacheControl?.NoStore).IsTrue();
        using var draft = await fixture.Client.GetAsync($"/api/v1/projects/{data.ProjectId}");
        await Assert.That(draft.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var denied = await fixture.Client.GetAsync($"/api/v1/publications/{id}");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var deniedManifest = await fixture.Client.GetAsync($"/api/v1/publications/{id}/manifest");
        await Assert.That(deniedManifest.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(1);
        var project = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
        await Assert.That(project.Revision).IsEqualTo(0);
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(original), JsonNode.Parse(project.DocumentJson))).IsTrue();
    }

    [Test]
    public async Task Publish_ReplayCannotRestoreRevocationOrChangeTheOriginalIntent()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var id = Guid.NewGuid();
        using var created = await PublishAsync(fixture, data.ProjectId, id);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var changed = await PublishAsync(fixture, data.ProjectId, id, viewers: [data.OtherStudent]);
        await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.Conflict);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{id}/access")
        {
            Content = JsonContent.Create(new { audience = "Authenticated", viewerIds = Array.Empty<Guid>(), action = "revoke" }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        using var revoked = await fixture.Client.SendAsync(request);
        await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        using var retry = await PublishAsync(fixture, data.ProjectId, id);
        await Assert.That(retry.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        using var hidden = await fixture.Client.GetAsync($"/api/v1/publications/{id}");
        await Assert.That(hidden.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        using var hiddenManifest = await fixture.Client.GetAsync($"/api/v1/publications/{id}/manifest");
        await Assert.That(hiddenManifest.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That((await database.PublicationAccess.SingleAsync()).Revoked).IsTrue();
    }

    [Test]
    public async Task Publish_PolicyStorageFailureRollsBackTheImmutableEdition()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        // Inject a storage failure only in this fixture's isolated schema, after the edition insert
        await database.Database.ExecuteSqlRawAsync("""
            CREATE FUNCTION reject_test_publication_policy() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'Synthetic policy storage failure'; END; $$;
            CREATE TRIGGER test_reject_publication_policy BEFORE INSERT ON publication_access
                FOR EACH ROW EXECUTE FUNCTION reject_test_publication_policy();
            """);
        using var response = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid());
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(problem.GetProperty("code").GetString()).IsEqualTo("storage_unavailable");
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Publish_RejectsMalformedIntentMissingCsrfAndAccountSwitchWithoutWrites()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, _) = await PrepareAsync(fixture);
        var path = $"/api/v1/projects/{data.ProjectId}/publications";
        var id = Guid.NewGuid();
        foreach (var intent in new[]
        {
            "{}", "{\"audience\":\"Authenticated\",\"viewerIds\":[],\"extra\":true}",
            "{\"audience\":\"Authenticated\",\"viewerIds\":[null]}",
        })
        {
            using var parsed = JsonDocument.Parse(intent);
            using var request = new HttpRequestMessage(HttpMethod.Post, path)
            {
                Content = JsonContent.Create(new { publicationId = id, confirmedRevision = 0, intent = parsed.RootElement }),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var response = await fixture.Client.SendAsync(request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        }
        var body = new { publicationId = id, confirmedRevision = 0, intent = new { audience = "Authenticated", viewerIds = Array.Empty<Guid>() } };
        using var noCsrf = await fixture.Client.PostAsJsonAsync(path, body);
        await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        using var stale = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        stale.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        stale.Headers.Add("X-Spatia-Account", data.Student.ToString());
        using var switched = await fixture.Client.SendAsync(stale);
        await Assert.That(switched.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments("approval", 409)]
    [Arguments("origin", 503)]
    [Arguments("asset", 422)]
    [Arguments("revision", 409)]
    [Arguments("viewer", 403)]
    [Arguments("configuration", 503)]
    public async Task Publish_UnreadyDependenciesNeverLeavePartialEditions(string reason, int status)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var (data, asset) = await PrepareAsync(fixture, approve: reason != "approval");
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (reason == "origin")
            {
                var original = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
                var id = Guid.NewGuid();
                var document = JsonNode.Parse(original.DocumentJson)!;
                document["projectId"] = id.ToString();
                database.Projects.Add(new Project
                {
                    Id = id,
                    OrganizationId = original.OrganizationId,
                    DocumentJson = document.ToJsonString(),
                    SchemaVersion = 1,
                    UpdatedAt = DateTimeOffset.UtcNow,
                });
                database.ProjectAssignments.Add(new ProjectAssignment
                {
                    ProjectId = id,
                    UserId = data.Educator,
                    CanEdit = true,
                    CanManage = true,
                    CanPublish = true,
                });
                await database.SaveChangesAsync();
                data = data with { ProjectId = id };
            }
            if (reason == "asset")
            {
                await database.AssetCandidates.Where(row => row.Id == asset.Id).ExecuteUpdateAsync(set =>
                    set.SetProperty(row => row.Hidden, true).SetProperty(row => row.Deleted, true).SetProperty(row => row.RemovedFromProjects, true));
            }
        }
        if (reason == "configuration") { fixture.App.Configuration["Publication:Origin"] = "http://unsafe.example.test"; }
        var audience = reason == "public" ? "Public" : reason == "unlisted" ? "Unlisted" : "Authenticated";
        var viewers = reason == "viewer" ? new[] { Guid.NewGuid() } : Array.Empty<Guid>();
        using var response = await PublishAsync(fixture, data.ProjectId, Guid.NewGuid(), audience, viewers, reason == "revision" ? 1 : 0);
        await Assert.That((int)response.StatusCode).IsEqualTo(status);
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var db = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Publications.CountAsync()).IsEqualTo(0);
        await Assert.That(await db.PublicationAccess.CountAsync()).IsEqualTo(0);
    }

    internal static async Task<(ReviewSubmissionEndpointTests.Seeded Data, AssetCandidate Asset)> PrepareAsync(
        HttpsApplicationFixture fixture, bool approve = true, bool interactions = false, Guid? assetOwner = null, bool content = false, bool enabledRule = false, long revision = 0)
    {
        fixture.App.Configuration["Publication:Origin"] = "https://publications.example.test";
        var data = await ReviewSubmissionEndpointTests.SeedAsync(fixture, false);
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = "Synthetic room",
            Kind = "environment",
            Bytes = bytes,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            Status = "approved",
            ValidationJson = "{}",
            Source = "Synthetic fixture",
            License = "Synthetic test only",
            ReviewNotes = "Fixture approval",
            SubmittedBy = assetOwner ?? data.Educator,
            ReviewedBy = assetOwner ?? data.Educator,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.AssetCandidates.Add(asset);
            // Match student permissions created by the production class assignment workflow
            await database.ProjectAssignments.Where(row => row.ProjectId == data.ProjectId && row.UserId == data.Student)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.CanPublish, true));
            var project = await database.Projects.SingleAsync(row => row.Id == data.ProjectId);
            project.Revision = revision;
            var document = JsonNode.Parse(project.DocumentJson)!;
            document["scenes"]![0]!["environmentAssetId"] = asset.Id.ToString();
            document["scenes"]![0]!["objects"] = new JsonArray();
            if (interactions) { document["scenes"]![0]!["interactions"] = JsonNode.Parse("""[{"when":{"type":"scene-starts"},"do":{"type":"open-link","url":"https://example.com/"}}]"""); }
            if (content)
            {
                // Reuse the shared two-scene fixture with approved identities from this database
                var model = new AssetCandidate
                {
                    Id = Guid.NewGuid(),
                    Name = "Synthetic model",
                    Kind = "model",
                    Bytes = bytes,
                    Sha256 = asset.Sha256,
                    Status = "approved",
                    ValidationJson = "{}",
                    Source = asset.Source,
                    License = asset.License,
                    ReviewNotes = asset.ReviewNotes,
                    SubmittedBy = data.Educator,
                    ReviewedBy = data.Educator,
                    CreatedAt = DateTimeOffset.UtcNow,
                };
                database.AssetCandidates.Add(model);
                document = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "m2-publication-project.json")))!;
                document["projectId"] = data.ProjectId.ToString();
                foreach (var scene in document["scenes"]!.AsArray())
                {
                    scene!["environmentAssetId"] = asset.Id.ToString();
                    foreach (var item in scene["objects"]!.AsArray()) { item!["assetId"] = model.Id.ToString(); }
                }
                var audioBytes = File.ReadAllBytes(Path.GetFullPath("../../../../../../assets/delivery/audio/calm-piano.m4a", AppContext.BaseDirectory));
                var audio = new AssetCandidate
                {
                    Id = Guid.NewGuid(),
                    Name = "Fixture BGM",
                    Kind = "audio",
                    Category = "BGM",
                    Bytes = audioBytes,
                    Sha256 = Convert.ToHexStringLower(SHA256.HashData(audioBytes)),
                    Status = "approved",
                    ValidationJson = "{}",
                    Source = asset.Source,
                    License = asset.License,
                    ReviewNotes = asset.ReviewNotes,
                    SubmittedBy = data.Educator,
                    ReviewedBy = data.Educator,
                    CreatedAt = DateTimeOffset.UtcNow,
                };
                database.AssetCandidates.Add(audio);
                var sceneAudio = JsonNode.Parse("""{"id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","type":"audio","mode":"global","assetId":"","caption":"BGM","loop":true,"volume":0.4}""")!;
                sceneAudio["assetId"] = audio.Id.ToString();
                document["scenes"]![0]!["audio"] = new JsonArray(sceneAudio);
                document["scenes"]![0]!["hotspots"] = JsonNode.Parse($$"""[{"id":"77777777-7777-4777-8777-777777777777","objectId":"{{document["scenes"]![0]!["objects"]![0]!["id"]!.GetValue<string>()}}","position":[0,0,0]}]""");
                document["scenes"]![0]!["interactions"] = JsonNode.Parse("""[{"when":{"type":"visitor-clicks-hotspot","targetHotspotId":"77777777-7777-4777-8777-777777777777"},"do":{"type":"play-audio","mediaId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}}]""");
                document["scenes"]![0]!["rules"]![0]!["enabled"] = enabledRule;
                project.SchemaVersion = 2;
            }
            project.DocumentJson = document.ToJsonString();
            await database.SaveChangesAsync();
        }
        var submission = Guid.NewGuid();
        using var submitted = await ReviewSubmissionEndpointTests.SubmitAsync(fixture, data.ProjectId, submission, revision, true);
        await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await fixture.SignInAsync(data.Educator);
        if (approve)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{data.ProjectId}/submissions/{submission}/decisions")
            {
                Content = JsonContent.Create(new { decisionId = Guid.NewGuid(), expectedRevision = revision, outcome = "approved", feedback = "Approved" }),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var approved = await fixture.Client.SendAsync(request);
            await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created);
        }
        return (data, asset);
    }

    private static async Task<HttpResponseMessage> PublishAsync(HttpsApplicationFixture fixture, Guid project, Guid id,
        string audience = "Authenticated", Guid[]? viewers = null, long revision = 0)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/projects/{project}/publications")
        {
            Content = JsonContent.Create(new { publicationId = id, confirmedRevision = revision, intent = new { audience, viewerIds = viewers ?? [] } }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        return await fixture.Client.SendAsync(request);
    }
}
