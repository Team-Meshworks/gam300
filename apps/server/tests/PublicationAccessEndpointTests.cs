using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Npgsql;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class PublicationAccessEndpointTests
{
    [Test]
    public async Task PolicyChange_ExpiryBeforeCommitRollsBackTheChange()
    {
        var probe = new ExpireAfterSave();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(
            builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(probe)), environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var publication = data.GetProperty("publicationId").GetGuid();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("manager").GetProperty("userId").GetGuid());
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{publication}/access")
        {
            Content = JsonContent.Create(new { audience = "Authenticated", viewerIds = Array.Empty<Guid>(), action = "hide" }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
        probe.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var response = await fixture.Client.SendAsync(request);
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == publication)).Hidden).IsFalse();

        // The project-wide operation must roll back both access flags and tombstones at the same cutoff
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("admin").GetProperty("userId").GetGuid());
        var csrf = await fixture.GetCsrfAsync();
        probe.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var moderation = await AuthTestRequests.PostAsync(fixture,
            $"/api/v1/admin/projects/{data.GetProperty("projectId").GetGuid()}/publication-moderation", new { action = "delete" }, token: csrf);
        await Assert.That(moderation.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await Assert.That(await database.PublicationAccess.CountAsync(row => row.Deleted)).IsEqualTo(0);
        await Assert.That(await database.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM retired_publication_ids").SingleAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Delivery_HeadUsesTheSameAuthorityAndMetadataWithoutABody()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var publication = data.GetProperty("publicationId").GetGuid();
        var asset = data.GetProperty("assetId").GetGuid();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("viewer").GetProperty("userId").GetGuid());
        using var anonymous = fixture.CreateClient();
        foreach (var path in new[] { $"/api/v1/publications/{publication}", $"/api/v1/publications/{publication}/assets/{asset}/bytes" })
        {
            using var get = await fixture.Client.GetAsync(path);
            using var headRequest = new HttpRequestMessage(HttpMethod.Head, path);
            using var head = await fixture.Client.SendAsync(headRequest);
            await Assert.That(get.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(head.StatusCode).IsEqualTo(get.StatusCode);
            await Assert.That(head.Content.Headers.ContentType?.ToString()).IsEqualTo(get.Content.Headers.ContentType?.ToString());
            await Assert.That(head.Content.Headers.ContentLength).IsEqualTo(get.Content.Headers.ContentLength);
            await Assert.That(head.Headers.CacheControl?.NoStore).IsTrue();
            await Assert.That((await head.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
            using var deniedRequest = new HttpRequestMessage(HttpMethod.Head, path);
            using var denied = await anonymous.SendAsync(deniedRequest);
            await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
            await Assert.That(denied.Headers.CacheControl?.NoStore).IsTrue();
            await Assert.That((await denied.Content.ReadAsByteArrayAsync()).Length).IsEqualTo(0);
        }
    }

    private sealed class ExpireAfterSave : SaveChangesInterceptor
    {
        public Action? After;
        public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return ValueTask.FromResult(result);
        }
    }

    [Test]
    public async Task Browser_PublicationAudienceLifecycleAndProtectedBytesUseCurrentAuthority()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        var serverDirectory = FindServerDirectory();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = serverDirectory,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add(Path.Combine(serverDirectory, "tests/publication-access-browser.check.mjs"));
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(JsonSerializer.Serialize(data));
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the publication browser check");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(5)); }
        catch (Exception exception)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            if (exception is TimeoutException)
            {
                throw new TimeoutException($"Browser check timed out. stdout: {await output}; stderr: {await error}", exception);
            }
            throw;
        }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        var evidence = await output;
        await Assert.That(evidence.Contains("publication access matrix passed", StringComparison.Ordinal)).IsTrue();
        var artifacts = Path.Combine(serverDirectory, ".artifacts");
        Directory.CreateDirectory(artifacts);
        await File.WriteAllTextAsync(Path.Combine(artifacts, "scrum71-publication-browser.txt"), evidence);

        // Visitor and management operations keep immutable editions and retained asset bytes intact
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(4);
        await Assert.That(await database.AssetCandidates.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync(row => row.Deleted)).IsEqualTo(1);
        await Assert.That(await database.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM retired_publication_ids").SingleAsync()).IsEqualTo(1);
        await Assert.That(await database.PublicationAccess.CountAsync(row => row.Revoked)).IsEqualTo(1);
    }

    [Test]
    public async Task AudienceChange_CurrentPublisherCanChooseAnonymousModes()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var publication = data.GetProperty("publicationId").GetGuid();
        var project = data.GetProperty("projectId").GetGuid();
        using var administrator = fixture.CreateClient();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("admin").GetProperty("userId").GetGuid(), administrator);
        await using var metadataScope = fixture.Database.Services.CreateAsyncScope();
        var metadata = metadataScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        // Isolate this edition so other anonymous fixture editions cannot keep the project public
        var editionIds = metadata.Publications.Where(row => row.ProjectId == project).Select(row => row.Id);
        await metadata.PublicationAccess.Where(row => editionIds.Contains(row.PublicationId))
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Audience, 3));
        async Task AssertVisibility(bool expected, bool archived = false)
        {
            using var listed = await administrator.GetAsync($"/api/v1/projects?archived={archived.ToString().ToLowerInvariant()}");
            await Assert.That(listed.StatusCode).IsEqualTo(HttpStatusCode.OK);
            var summary = (await listed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray()
                .Single(row => row.GetProperty("projectId").GetGuid() == project);
            await Assert.That(summary.GetProperty("isPublic").GetBoolean()).IsEqualTo(expected);
        }
        await AssertVisibility(false);
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("publisher").GetProperty("userId").GetGuid());
        foreach (var audience in new[] { "Public", "Unlisted" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{publication}/access")
            {
                Content = JsonContent.Create(new { audience, viewerIds = Array.Empty<Guid>(), action = "audience" }),
            };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var response = await fixture.Client.SendAsync(request);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await AssertVisibility(true);
        }
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var state = await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == publication);
        await Assert.That(state.Audience).IsEqualTo(2);
        await Assert.That(state.ViewerIds.Length).IsEqualTo(0);
        using var anonymous = fixture.CreateClient();
        using var denied = await anonymous.GetAsync($"/api/v1/publications/{publication}");
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.OK);

        // Reversible visitor restrictions independently remove the project's Public label
        foreach (var restriction in new[] { "hidden", "revoked" })
        {
            await metadata.PublicationAccess.Where(row => row.PublicationId == publication).ExecuteUpdateAsync(set => set
                .SetProperty(row => row.Hidden, restriction == "hidden")
                .SetProperty(row => row.Revoked, restriction == "revoked"));
            await AssertVisibility(false);
            using var restricted = await anonymous.GetAsync($"/api/v1/publications/{publication}");
            await Assert.That(restricted.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }
        await metadata.PublicationAccess.Where(row => row.PublicationId == publication)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Hidden, false).SetProperty(row => row.Revoked, false));
        await metadata.Projects.Where(row => row.Id == project).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, true));
        await AssertVisibility(false, archived: true);
        await metadata.Projects.Where(row => row.Id == project).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, false));

        // Isolate a separate edition to prove tombstones override otherwise unrestricted policy rows
        var otherEdition = data.GetProperty("unlistedId").GetGuid();
        await metadata.PublicationAccess.Where(row => row.PublicationId == publication)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Audience, 3));
        await metadata.PublicationAccess.Where(row => row.PublicationId == otherEdition)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Audience, 2));
        await AssertVisibility(true);
        await metadata.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO retired_publication_ids (id) VALUES ({otherEdition})");
        await AssertVisibility(false);
        using var retired = await anonymous.GetAsync($"/api/v1/publications/{otherEdition}");
        await Assert.That(retired.StatusCode).IsEqualTo(HttpStatusCode.NotFound);

        // Permanent deletion comes last and is never cleared during a fixture reset
        await metadata.PublicationAccess.Where(row => row.PublicationId == publication)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Audience, 2));
        await AssertVisibility(true);
        await metadata.PublicationAccess.Where(row => row.PublicationId == publication)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Deleted, true));
        await AssertVisibility(false);
        using var deleted = await anonymous.GetAsync($"/api/v1/publications/{publication}");
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task AudienceChange_WaitingForProjectLockRechecksRemovedPublisherAuthority()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var projectId = data.GetProperty("projectId").GetGuid();
        var publicationId = data.GetProperty("publicationId").GetGuid();
        var publisher = data.GetProperty("actors").GetProperty("publisher").GetProperty("userId").GetGuid();
        await fixture.SignInAsync(publisher);
        var csrf = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var held = await database.Database.BeginTransactionAsync();
        await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM projects WHERE id = {projectId} FOR UPDATE").ToListAsync();

        // Force the HTTP request to wait after its preliminary permission check
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/publications/{publicationId}/access");
        request.Headers.Add("X-CSRF-TOKEN", csrf);
        request.Content = JsonContent.Create(new { audience = "Public", viewerIds = Array.Empty<Guid>(), action = "audience" });
        var pending = fixture.Client.SendAsync(request);
        var released = false;
        try
        {
            await using var observerScope = fixture.Database.Services.CreateAsyncScope();
            var observer = (NpgsqlConnection)observerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetDbConnection();
            await observer.OpenAsync();
            await using var blocked = new NpgsqlCommand("SELECT count(*) FROM pg_stat_activity WHERE application_name = @name AND wait_event_type = 'Lock'", observer);
            blocked.Parameters.AddWithValue("name", "Spatia.Part3." + fixture.Database.SchemaName);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((long)(await blocked.ExecuteScalarAsync(timeout.Token) ?? 0L) == 0)
            {
                await Task.Delay(10, timeout.Token);
            }

            // Commit the competing grant removal before allowing the queued policy change to continue
            await database.ProjectAssignments.Where(row => row.ProjectId == projectId && row.UserId == publisher).ExecuteDeleteAsync();
            await held.CommitAsync();
            released = true;
        }
        finally
        {
            if (!released) { await held.RollbackAsync(); }
        }
        using var response = await pending;
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        var retained = await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == publicationId);
        await Assert.That(retained.Audience).IsEqualTo(3);
        await Assert.That(retained.ViewerIds.Length).IsEqualTo(1);
    }

    [Test]
    public async Task ProjectModeration_CurrentAdminPreservesDraftAndPermanentlyRetiresEveryEdition()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var projectId = data.GetProperty("projectId").GetGuid();
        var authenticatedId = data.GetProperty("publicationId").GetGuid();
        var deletedId = data.GetProperty("deletedId").GetGuid();
        var publicId = data.GetProperty("publicId").GetGuid();
        var retiredId = data.GetProperty("unlistedId").GetGuid();
        var adminId = data.GetProperty("actors").GetProperty("admin").GetProperty("userId").GetGuid();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var draft = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId);
        var original = await database.Publications.AsNoTracking().SingleAsync(row => row.Id == publicId);
        var assetId = data.GetProperty("assetId").GetGuid();
        var bytes = await database.AssetCandidates.Where(row => row.Id == assetId).Select(row => row.Bytes).SingleAsync();

        // Include independent revocation, legacy deletion, retirement and an edition whose policy is absent
        await database.PublicationAccess.Where(row => row.PublicationId == authenticatedId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Revoked, true));
        await database.PublicationAccess.Where(row => row.PublicationId == deletedId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Deleted, true));
        await database.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO retired_publication_ids (id) VALUES ({retiredId})");
        var missingPolicyId = Guid.NewGuid();
        database.Publications.Add(new Publication
        {
            Id = missingPolicyId,
            ProjectId = projectId,
            PublishedById = original.PublishedById,
            SourceRevision = original.SourceRevision,
            SchemaVersion = original.SchemaVersion,
            DocumentJson = original.DocumentJson,
            AssetReferencesJson = original.AssetReferencesJson,
            RequestDigest = original.RequestDigest
        });
        var emptyProjectId = Guid.NewGuid();
        database.Projects.Add(new Project
        {
            Id = emptyProjectId,
            OrganizationId = draft.OrganizationId,
            DocumentJson = ProjectTestDocuments.Create(emptyProjectId, "No editions"),
            SchemaVersion = 1,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        await database.SaveChangesAsync();
        var allIds = new[] { authenticatedId, deletedId, publicId, retiredId, missingPolicyId };
        var path = $"/api/v1/admin/projects/{projectId}/publication-moderation";
        var query = $"/api/v1/admin/projects/publication-moderation?ids={projectId},{emptyProjectId}";

        // A forged administrator claim grants neither a student nor an assigned educator moderation authority
        foreach (var actor in new[] { "publisher", "manager" })
        {
            using var client = fixture.CreateClient();
            await fixture.SignInAsync(data.GetProperty("actors").GetProperty(actor).GetProperty("userId").GetGuid(), client, forgedRole: ApplicationRoles.Administrator);
            using var deniedRead = await client.GetAsync(query);
            await Assert.That(deniedRead.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
            using var deniedWrite = await AuthTestRequests.PostAsync(fixture, path, new { action = "hide" }, client);
            await Assert.That(deniedWrite.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        }
        await fixture.SignInAsync(adminId);
        async Task AssertCounts(int editions, int hidden, int visible)
        {
            using var response = await fixture.Client.GetAsync(query);
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
            var items = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").EnumerateArray().ToArray();
            await Assert.That(items.Length).IsEqualTo(2);
            var current = items.Single(row => row.GetProperty("projectId").GetGuid() == projectId);
            await Assert.That(current.GetProperty("publicationCount").GetInt32()).IsEqualTo(editions);
            await Assert.That(current.GetProperty("hiddenCount").GetInt32()).IsEqualTo(hidden);
            await Assert.That(current.GetProperty("publicCount").GetInt32()).IsEqualTo(visible);
            var empty = items.Single(row => row.GetProperty("projectId").GetGuid() == emptyProjectId);
            await Assert.That(empty.GetProperty("publicationCount").GetInt32()).IsEqualTo(0);
        }
        await AssertCounts(3, 0, 1);
        foreach (var invalid in new[] { "ids=bad", $"ids={projectId},{projectId}", $"ids={projectId}&ids={emptyProjectId}", $"ids={projectId}&extra=1" })
        {
            using var rejected = await fixture.Client.GetAsync("/api/v1/admin/projects/publication-moderation?" + invalid);
            await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        using (var missing = await fixture.Client.GetAsync($"/api/v1/admin/projects/publication-moderation?ids={projectId},{Guid.NewGuid()}"))
        { await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var noCsrf = await fixture.Client.PostAsJsonAsync(path, new { action = "hide" }))
        { await Assert.That(noCsrf.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        using (var invalid = await AuthTestRequests.PostAsync(fixture, path, new { action = "archive" }))
        { await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }

        // Hide and Show touch current visibility only; they preserve revocation, audience and missing-policy denial
        using (var hidden = await AuthTestRequests.PostAsync(fixture, path, new { action = "hide" }))
        { await Assert.That(hidden.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        await AssertCounts(3, 3, 0);
        using (var shown = await AuthTestRequests.PostAsync(fixture, path, new { action = "show" }))
        { await Assert.That(shown.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        await AssertCounts(3, 0, 1);
        var authenticated = await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == authenticatedId);
        await Assert.That(authenticated.Revoked).IsTrue();
        await Assert.That(authenticated.Audience).IsEqualTo(3);
        await Assert.That(authenticated.ViewerIds.SequenceEqual([data.GetProperty("actors").GetProperty("viewer").GetProperty("userId").GetGuid()])).IsTrue();
        await Assert.That((await database.PublicationAccess.AsNoTracking().SingleAsync(row => row.PublicationId == missingPolicyId)).Audience).IsEqualTo(0);
        using var anonymous = fixture.CreateClient();
        using (var missingPolicy = await anonymous.GetAsync($"/api/v1/publications/{missingPolicyId}"))
        { await Assert.That(missingPolicy.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await database.Projects.Where(row => row.Id == projectId).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, true));
        using (var archivedShow = await AuthTestRequests.PostAsync(fixture, path, new { action = "show" }))
        { await Assert.That(archivedShow.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        await AssertCounts(3, 0, 0);
        await Assert.That((await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId)).IsArchived).IsTrue();
        await database.Projects.Where(row => row.Id == projectId).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, false));

        // Permanent deletion backfills every tombstone while retaining the draft, edition snapshots and exact bytes
        using (var deleted = await AuthTestRequests.PostAsync(fixture, path, new { action = "delete" }))
        { await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent); }
        await AssertCounts(0, 0, 0);
        using (var publishedList = await fixture.Client.GetAsync("/api/v1/projects?published=true&limit=20"))
        {
            await Assert.That(publishedList.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That((await publishedList.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength()).IsEqualTo(0);
        }

        await Assert.That(await database.Publications.CountAsync(row => row.ProjectId == projectId)).IsEqualTo(5);
        await Assert.That(await database.PublicationAccess.CountAsync(row => allIds.Contains(row.PublicationId) && row.Deleted)).IsEqualTo(5);
        await Assert.That(await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids")
            .CountAsync(id => allIds.Contains(id))).IsEqualTo(5);
        var retained = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == projectId);
        await Assert.That(retained.DocumentJson).IsEqualTo(draft.DocumentJson);
        await Assert.That(retained.Revision).IsEqualTo(draft.Revision);
        await Assert.That(retained.UpdatedAt).IsEqualTo(draft.UpdatedAt);
        await Assert.That(retained.IsArchived).IsFalse();
        await Assert.That((await database.AssetCandidates.Where(row => row.Id == assetId).Select(row => row.Bytes).SingleAsync()).SequenceEqual(bytes)).IsTrue();
        await Assert.That((await database.Publications.AsNoTracking().SingleAsync(row => row.Id == publicId)).DocumentJson).IsEqualTo(original.DocumentJson);
        using (var reopened = await AuthTestRequests.PostAsync(fixture, path, new { action = "show" }))
        { await Assert.That(reopened.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var restored = await AuthTestRequests.PostAsync(fixture, $"/api/v1/publications/{publicId}/access",
            new { audience = "Public", viewerIds = Array.Empty<Guid>(), action = "show" }))
        { await Assert.That(restored.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        foreach (var id in allIds)
        {
            foreach (var suffix in new[] { "", $"/assets/{assetId}/bytes" })
            {
                using var denied = await anonymous.GetAsync($"/api/v1/publications/{id}{suffix}");
                await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
            }
        }
    }

    [Test]
    public async Task ExhibitionPreview_UsesLatestPublicationAndPinnedAssetsWithoutExposingDraftChanges()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var projectId = data.GetProperty("projectId").GetGuid();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var original = await database.Publications.AsNoTracking().FirstAsync(row => row.ProjectId == projectId);
        var document = JsonNode.Parse(original.DocumentJson)!;
        document["title"] = "Latest published exhibition";
        var latest = new Publication
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            PublishedById = original.PublishedById,
            SourceRevision = 7,
            SchemaVersion = original.SchemaVersion,
            DocumentJson = document.ToJsonString(),
            AssetReferencesJson = original.AssetReferencesJson,
            RequestDigest = new byte[32]
        };
        database.Publications.Add(latest);
        database.PublicationAccess.Add(new PublicationAccessState { PublicationId = latest.Id, Audience = 1, Hidden = true });
        document["title"] = "Unpublished changes";
        var draft = await database.Projects.SingleAsync(row => row.Id == projectId);
        draft.DocumentJson = document.ToJsonString();
        draft.Revision = 8;
        var unpublishedId = Guid.NewGuid();
        database.Projects.Add(new Project
        {
            Id = unpublishedId,
            OrganizationId = draft.OrganizationId,
            SchemaVersion = 1,
            UpdatedAt = DateTimeOffset.UtcNow,
            DocumentJson = ProjectTestDocuments.Create(unpublishedId, "Unpublished project")
        });
        await database.SaveChangesAsync();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("admin").GetProperty("userId").GetGuid());
        using var preview = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/exhibition");
        await Assert.That(preview.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(preview.Headers.CacheControl?.NoStore).IsTrue();
        var opened = await preview.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(opened.GetProperty("publicationId").GetGuid()).IsEqualTo(latest.Id);
        await Assert.That(opened.GetProperty("revision").GetInt64()).IsEqualTo(7);
        await Assert.That(opened.GetProperty("document").GetProperty("title").GetString()).IsEqualTo("Latest published exhibition");
        var assetUrl = opened.GetProperty("assets")[0].GetProperty("url").GetString()!;
        using var asset = await fixture.Client.GetAsync(assetUrl);
        await Assert.That(asset.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var published = await fixture.Client.GetAsync("/api/v1/projects?published=true&limit=20");
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var publishedBody = await published.Content.ReadFromJsonAsync<JsonElement>();
        var ids = publishedBody.GetProperty("items").EnumerateArray()
            .Select(row => row.GetProperty("projectId").GetGuid()).ToArray();
        await Assert.That(ids.Contains(projectId)).IsTrue();
        await Assert.That(ids.Contains(unpublishedId)).IsFalse();
        var listed = publishedBody.GetProperty("items").EnumerateArray()
            .Single(row => row.GetProperty("projectId").GetGuid() == projectId);
        await Assert.That(listed.GetProperty("title").GetString()).IsEqualTo("Latest published exhibition");

        document["title"] = "Republished exhibition";
        var republished = new Publication
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            PublishedById = original.PublishedById,
            SourceRevision = 8,
            SchemaVersion = original.SchemaVersion,
            DocumentJson = document.ToJsonString(),
            AssetReferencesJson = original.AssetReferencesJson,
            RequestDigest = new byte[32]
        };
        database.Publications.Add(republished);
        database.PublicationAccess.Add(new PublicationAccessState { PublicationId = republished.Id, Audience = 1 });
        await database.SaveChangesAsync();
        using var reopened = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/exhibition");
        var refreshed = await reopened.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(refreshed.GetProperty("publicationId").GetGuid()).IsEqualTo(republished.Id);
        await Assert.That(refreshed.GetProperty("document").GetProperty("title").GetString()).IsEqualTo("Republished exhibition");
        using var missing = await fixture.Client.GetAsync($"/api/v1/projects/{unpublishedId}/exhibition");
        await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("publisher").GetProperty("userId").GetGuid());
        using var creator = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/exhibition");
        await Assert.That(creator.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("manager").GetProperty("userId").GetGuid());
        using var educator = await fixture.Client.GetAsync($"/api/v1/projects/{projectId}/exhibition");
        await Assert.That(educator.StatusCode).IsEqualTo(HttpStatusCode.OK);
        using var foreignAsset = await fixture.Client.GetAsync(assetUrl.Replace(projectId.ToString(), unpublishedId.ToString()));
        await Assert.That(foreignAsset.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }

    [Test]
    public async Task SelectedPublicationModeration_HandlesMoreThanTwentyProjectsInOneRequest()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = JsonSerializer.SerializeToElement(await SeedAsync(fixture));
        var first = data.GetProperty("projectId").GetGuid();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var template = await database.Publications.AsNoTracking().FirstAsync(row => row.ProjectId == first);
        var organization = await database.Projects.Where(row => row.Id == first).Select(row => row.OrganizationId).SingleAsync();
        var ids = new List<Guid> { first };
        for (var index = 0; index < 24; index++)
        {
            var id = Guid.NewGuid();
            ids.Add(id);
            var document = JsonNode.Parse(template.DocumentJson)!;
            document["projectId"] = id.ToString();
            database.Projects.Add(new Project
            {
                Id = id,
                OrganizationId = organization,
                SchemaVersion = template.SchemaVersion,
                DocumentJson = document.ToJsonString(),
                UpdatedAt = DateTimeOffset.UtcNow
            });
            var publication = new Publication
            {
                Id = Guid.NewGuid(),
                ProjectId = id,
                PublishedById = template.PublishedById,
                SourceRevision = 0,
                SchemaVersion = template.SchemaVersion,
                DocumentJson = document.ToJsonString(),
                AssetReferencesJson = template.AssetReferencesJson,
                RequestDigest = new byte[32]
            };
            database.Publications.Add(publication);
            database.PublicationAccess.Add(new PublicationAccessState { PublicationId = publication.Id, Audience = 1 });
        }
        await database.SaveChangesAsync();
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("publisher").GetProperty("userId").GetGuid());
        using var denied = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/projects/publication-moderation", new { projectIds = ids, action = "hide" });
        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await fixture.SignInAsync(data.GetProperty("actors").GetProperty("admin").GetProperty("userId").GetGuid());
        foreach (var action in new[] { "hide", "show" })
        {
            using var changed = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/projects/publication-moderation", new { projectIds = ids, action });
            await Assert.That(changed.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            var hidden = await (from policy in database.PublicationAccess.AsNoTracking()
                                join publication in database.Publications on policy.PublicationId equals publication.Id
                                where ids.Contains(publication.ProjectId)
                                select policy.Hidden).ToArrayAsync();
            await Assert.That(hidden.All(value => value == (action == "hide"))).IsTrue();
        }
        using var deleted = await AuthTestRequests.PostAsync(fixture, "/api/v1/admin/projects/publication-moderation", new { projectIds = ids, action = "delete" });
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(await (from policy in database.PublicationAccess.AsNoTracking()
                                 join publication in database.Publications on policy.PublicationId equals publication.Id
                                 where ids.Contains(publication.ProjectId) && !policy.Deleted
                                 select policy.PublicationId).CountAsync()).IsEqualTo(0);
        await Assert.That(await database.Projects.CountAsync(row => ids.Contains(row.Id))).IsEqualTo(25);
    }

    private static async Task<object> SeedAsync(HttpsApplicationFixture fixture)
    {
        var publisher = await fixture.CreateAccountAsync();
        var viewer = await fixture.CreateAccountAsync();
        var unrelated = await fixture.CreateAccountAsync();
        var manager = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var foreign = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await database.OrganizationMemberships.Where(row => row.UserId == publisher)
            .Select(row => row.OrganizationId).SingleAsync();

        // Put named and unrelated students in the same organization without granting either draft access
        await database.OrganizationMemberships.Where(row => row.UserId == viewer || row.UserId == unrelated || row.UserId == manager)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
        var bytes = AssetIntakeTests.CreateMinimalGlb();
        var asset = new AssetCandidate
        {
            Id = Guid.NewGuid(),
            Name = "Retained publication room",
            Kind = "environment",
            Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            Bytes = bytes,
            Status = "approved",
            Hidden = true,
            Deleted = true,
            ValidationJson = "{}",
            Source = "Synthetic test material",
            License = "Synthetic fixture",
            ReviewNotes = "Fixture-only approval",
            SubmittedBy = admin,
            ReviewedBy = admin,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        database.AssetCandidates.Add(asset);
        var projectId = Guid.NewGuid();
        var document = JsonNode.Parse(ProjectTestDocuments.Create(projectId, "Protected publication snapshot"))!;
        document["scenes"]![0]!["environmentAssetId"] = asset.Id.ToString("D");
        document["scenes"]![0]!["objects"] = new JsonArray();
        database.Projects.Add(new Project
        {
            Id = projectId,
            OrganizationId = organization,
            DocumentJson = document.ToJsonString(),
            SchemaVersion = 1,
            Revision = 0,
            UpdatedAt = DateTimeOffset.UtcNow,
        });
        database.ProjectAssignments.AddRange(
            new ProjectAssignment { ProjectId = projectId, UserId = publisher, CanEdit = true, CanPublish = true },
            new ProjectAssignment { ProjectId = projectId, UserId = manager, CanEdit = true, CanManage = true, CanPublish = true });
        await database.SaveChangesAsync();

        // Seed real immutable storage; all subsequent reads and permission changes go through production HTTP routes
        var publicationId = Guid.NewGuid();
        var deletedId = Guid.NewGuid();
        var publicId = Guid.NewGuid();
        var unlistedId = Guid.NewGuid();
        foreach (var (id, audience) in new[] { (publicationId, 3), (deletedId, 3), (publicId, 1), (unlistedId, 2) })
        {
            database.Publications.Add(new Publication
            {
                Id = id,
                ProjectId = projectId,
                PublishedById = publisher,
                SourceRevision = 0,
                SchemaVersion = 1,
                DocumentJson = document.ToJsonString(),
                RequestDigest = new byte[32],
                AssetReferencesJson = PublicationAssetManifest.Serialize([new(asset.Id.ToString("D"), asset.Sha256)]),
            });
            database.PublicationAccess.Add(new PublicationAccessState { PublicationId = id, Audience = audience, ViewerIds = [viewer] });
        }
        await database.SaveChangesAsync();
        var actors = new Dictionary<string, object>();
        foreach (var (name, id) in new[] { ("publisher", publisher), ("viewer", viewer), ("unrelated", unrelated),
            ("manager", manager), ("admin", admin), ("foreign", foreign) })
        {
            actors[name] = new { userId = id, userName = await AuthTestRequests.UserNameAsync(fixture, id) };
        }
        return new { projectId, publicationId, deletedId, publicId, unlistedId, assetId = asset.Id, actors };
    }

    private static string FindServerDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "apps/server");
            if (File.Exists(Path.Combine(candidate, "tests/publication-access-browser.check.mjs"))) { return candidate; }
        }
        throw new InvalidOperationException("Cannot locate the publication browser check");
    }
}
