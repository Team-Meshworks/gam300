using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(OrganizationDeletionTests))]
public sealed class OrganizationDeletionTests
{
    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Delete_RemovesAllOwnedDataAndAccountsButKeepsOtherOrganizationsAndAssets(bool builtIn)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var (data, asset) = await PublicationEndpointTests.PrepareAsync(fixture, assetOwner: admin, starterRoom: builtIn);
        var publication = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, publication);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var memberClient = fixture.CreateClient();
        await fixture.SignInAsync(data.Student, memberClient);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await db.OrganizationMemberships.Where(row => row.UserId == data.Student)
            .Select(row => row.OrganizationId).SingleAsync();
        var document = await db.Projects.Where(row => row.Id == data.ProjectId).Select(row => row.DocumentJson).SingleAsync();
        using var saved = await ReviewSubmissionEndpointTests.SaveAsync(fixture, data.ProjectId, json: document);
        await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await db.Projects.Where(row => row.OrganizationId == organization && row.Id != data.ProjectId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, true));
        db.UserClaims.Add(new IdentityUserClaim<Guid> { UserId = data.Student, ClaimType = "fixture", ClaimValue = "value" });
        db.UserTokens.Add(new IdentityUserToken<Guid> { UserId = data.Student, LoginProvider = "fixture", Name = "token", Value = "value" });
        db.UserLogins.Add(new IdentityUserLogin<Guid> { UserId = data.Student, LoginProvider = "fixture", ProviderKey = "key" });
        await db.SaveChangesAsync();
        var (other, _) = await PublicationEndpointTests.PrepareAsync(fixture, assetOwner: admin, starterRoom: builtIn);
        var otherPublication = Guid.NewGuid();
        using var otherPublished = await PublishAsync(fixture, other.ProjectId, otherPublication);
        await Assert.That(otherPublished.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var otherDocument = await db.Projects.Where(row => row.Id == other.ProjectId).Select(row => row.DocumentJson).SingleAsync();
        // Old access references can outlive an account's organization membership.
        db.ProjectAssignments.Add(new ProjectAssignment { ProjectId = other.ProjectId, UserId = data.Student, CanEdit = true });
        await db.SaveChangesAsync();
        await db.PublicationAccess.Where(row => row.PublicationId == otherPublication)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.ViewerIds, new[] { data.Student, other.Student }));
        await using (var transaction = await db.Database.BeginTransactionAsync())
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT set_config('spatia.purge_organization', {organization.ToString("D")}, true)");
            await AssertConstraintAsync(db, $"DELETE FROM publications WHERE id = '{otherPublication}'", "CK_publications_immutable");
            await transaction.RollbackAsync();
        }
        await fixture.SignInAsync(admin);

        using var preview = await fixture.Client.GetAsync($"{Path(organization)}/deletion");
        await Assert.That(preview.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(preview.Headers.CacheControl?.NoStore).IsTrue();
        var summary = await preview.Content.ReadFromJsonAsync<JsonElement>();
        foreach (var (key, expected) in new[] { ("accounts", 3), ("classes", 1), ("assignments", 1), ("projects", 2), ("submissions", 1), ("reviews", 1), ("publications", 1) })
        {
            await Assert.That(summary.GetProperty(key).GetInt32()).IsEqualTo(expected);
        }
        using var deleted = await DeleteAsync(fixture, organization);
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await AuthTestRequests.AssertSafeAsync(fixture, deleted);
        await Assert.That(await db.Organizations.AnyAsync(row => row.Id == organization)).IsFalse();
        Guid[] removed = [data.Student, data.OtherStudent, data.Educator];
        await Assert.That(await db.Users.AnyAsync(row => removed.Contains(row.Id))).IsFalse();
        await Assert.That(await db.UserRoles.AnyAsync(row => removed.Contains(row.UserId))).IsFalse();
        await Assert.That(await db.UserClaims.AnyAsync(row => removed.Contains(row.UserId))).IsFalse();
        await Assert.That(await db.UserTokens.AnyAsync(row => removed.Contains(row.UserId))).IsFalse();
        await Assert.That(await db.UserLogins.AnyAsync(row => removed.Contains(row.UserId))).IsFalse();
        await Assert.That(await db.OrganizationMemberships.AnyAsync(row => row.OrganizationId == organization)).IsFalse();
        await Assert.That(await db.Classrooms.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ClassroomMembers.CountAsync()).IsEqualTo(3);
        await Assert.That(await db.ClassAssignments.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ClassAssignmentStudents.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ProjectProvenances.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(2);
        await Assert.That(await db.ProjectAssignments.CountAsync()).IsEqualTo(2);
        await Assert.That(await db.ProjectSaveReceipts.CountAsync()).IsEqualTo(0);
        await Assert.That(await db.ReviewSubmissions.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ReviewDecisions.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.PublicationAccess.CountAsync()).IsEqualTo(1);
        var retainedViewers = await db.PublicationAccess.Where(row => row.PublicationId == otherPublication).Select(row => row.ViewerIds).SingleAsync();
        await Assert.That(retainedViewers.Length).IsEqualTo(1);
        await Assert.That(retainedViewers[0]).IsEqualTo(other.Student);
        await Assert.That(await db.AssetCandidates.CountAsync()).IsEqualTo(2);
        await Assert.That(await db.Users.AnyAsync(row => row.Id == admin)).IsTrue();
        await Assert.That(await db.Users.AnyAsync(row => row.Id == other.Student)).IsTrue();
        await Assert.That(await db.Projects.Where(row => row.Id == other.ProjectId).Select(row => row.DocumentJson).SingleAsync()).IsEqualTo(otherDocument);
        using var oldSession = await memberClient.GetAsync("/api/v1/auth/session");
        await Assert.That(oldSession.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        foreach (var suffix in new[] { "", "/manifest", $"/assets/{asset.Id}/bytes", "/assets/test-room-v1/bytes" })
        {
            using var oldLink = await fixture.Client.GetAsync($"/api/v1/publications/{publication}{suffix}");
            await Assert.That(oldLink.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }
        if (builtIn)
        {
            await Assert.That(await db.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM development_publication_assets").SingleAsync()).IsEqualTo(1);
            await Assert.That(await db.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM development_publication_blobs").SingleAsync()).IsEqualTo(1);
            using var retainedClient = fixture.CreateClient();
            await fixture.SignInAsync(other.Student, retainedClient);
            using var retained = await retainedClient.GetAsync($"/api/v1/publications/{otherPublication}/assets/test-room-v1/bytes");
            await Assert.That(retained.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await AssertConstraintAsync(db, "DELETE FROM development_publication_assets", "CK_development_publication_assets_immutable");
            await AssertConstraintAsync(db, "UPDATE development_publication_assets SET placement = NULL", "CK_development_publication_assets_immutable");
            await AssertConstraintAsync(db, "DELETE FROM development_publication_blobs", "CK_development_publication_assets_immutable");
            await using var purge = await db.Database.BeginTransactionAsync();
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT set_config('spatia.purge_organization', {organization.ToString("D")}, true)");
            await AssertConstraintAsync(db, $"DELETE FROM development_publication_assets WHERE publication_id = '{otherPublication}'", "CK_development_publication_assets_immutable");
            await purge.RollbackAsync();
        }
        await fixture.SignInAsync(other.Student);
        using var reused = await PublishAsync(fixture, other.ProjectId, publication);
        await AuthTestRequests.AssertProblemAsync(reused, HttpStatusCode.Conflict, "publication_id_conflict");
        await AssertConstraintAsync(db, $"DELETE FROM publications WHERE id = '{otherPublication}'", "CK_publications_immutable");
        await AssertConstraintAsync(db, "DELETE FROM review_decisions", "CK_review_evidence_immutable");
        await AssertConstraintAsync(db, "DELETE FROM review_submissions", "CK_review_evidence_immutable");
        await AssertConstraintAsync(db, "DELETE FROM publication_access", "CK_publication_access_permanent");
        await AssertConstraintAsync(db, "DELETE FROM retired_publication_ids", "CK_publication_id_retired");
        await AssertConstraintAsync(db, $"""
            INSERT INTO publications (id, project_id, published_by_id, source_revision, schema_version, document, asset_references, request_digest)
            SELECT '{publication}'::uuid, project_id, published_by_id, source_revision, schema_version, document, asset_references, request_digest
            FROM publications WHERE id = '{otherPublication}'
            """, "CK_publication_id_retired");
        await fixture.SignInAsync(admin);
        using var repeated = await DeleteAsync(fixture, organization);
        await AuthTestRequests.AssertProblemAsync(repeated, HttpStatusCode.NotFound, "organization_not_found");
    }

    [Test]
    [Arguments("anonymous", 401)]
    [Arguments(ApplicationRoles.Creator, 403)]
    [Arguments(ApplicationRoles.Educator, 403)]
    [Arguments("forced", 403)]
    [Arguments("disabled", 401)]
    public async Task Delete_RequiresCurrentFullAdministrator(string actor, int expected)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var member = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var org = await db.OrganizationMemberships.Where(row => row.UserId == member).Select(row => row.OrganizationId).SingleAsync();
        if (actor != "anonymous")
        {
            var id = await fixture.CreateAccountAsync(actor is "forced" or "disabled" ? ApplicationRoles.Administrator : actor, forced: actor == "forced");
            await fixture.SignInAsync(id, forgedRole: ApplicationRoles.Administrator);
            if (actor == "disabled")
            {
                await db.Users.Where(row => row.Id == id).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
            }
        }
        using var preview = await fixture.Client.GetAsync($"{Path(org)}/deletion");
        using var deleted = await DeleteAsync(fixture, org);
        await Assert.That((int)preview.StatusCode).IsEqualTo(expected);
        await Assert.That((int)deleted.StatusCode).IsEqualTo(expected);
        await Assert.That(await db.Organizations.AnyAsync(row => row.Id == org)).IsTrue();
        await Assert.That(await db.Users.AnyAsync(row => row.Id == member)).IsTrue();
    }

    [Test]
    public async Task Delete_RequiresCsrfAndExactNameAndSupportsEmptyInactiveOrganization()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var org = new Organization { Id = Guid.NewGuid(), Name = "Confirm this name", IsActive = false };
        db.Organizations.Add(org);
        await db.SaveChangesAsync();
        foreach (var json in new[] { "{}", "{\"confirmationName\":null}", "{\"confirmationName\":\"\"}", "{\"confirmationName\":\"confirm this name\"}", "{\"confirmationName\":\"Confirm this name \"}" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Delete, Path(org.Id)) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync());
            using var invalid = await fixture.Client.SendAsync(request);
            await Assert.That(invalid.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        }
        using var noToken = new HttpRequestMessage(HttpMethod.Delete, Path(org.Id)) { Content = JsonContent.Create(new { confirmationName = org.Name }) };
        using var rejected = await fixture.Client.SendAsync(noToken);
        await AuthTestRequests.AssertProblemAsync(rejected, HttpStatusCode.BadRequest, "csrf_invalid");
        await Assert.That(await db.Organizations.AnyAsync(row => row.Id == org.Id)).IsTrue();
        using var deleted = await DeleteAsync(fixture, org.Id, org.Name);
        await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(await db.Organizations.AnyAsync(row => row.Id == org.Id)).IsFalse();
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Delete_ConflictOrCommitFailureRollsBackEveryRecord(bool failCommit)
    {
        var commit = new AdministrationCommitInterceptor();
        var failures = new CommandFailureProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, failures)));
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        // A legacy asset attributed to a member is a cross-boundary reference: preserve it and roll back.
        var (data, _) = await PublicationEndpointTests.PrepareAsync(fixture, assetOwner: failCommit ? admin : null);
        var publication = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, publication);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await fixture.SignInAsync(admin);
        var token = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var org = await db.OrganizationMemberships.Where(row => row.UserId == data.Student).Select(row => row.OrganizationId).SingleAsync();
        if (failCommit)
        {
            commit.Arm();
        }

        using var rejected = await DeleteAsync(fixture, org, token: token);
        await Assert.That(rejected.StatusCode).IsEqualTo(failCommit ? HttpStatusCode.InternalServerError : HttpStatusCode.Conflict)
            .Because(failures.Failure ?? "Deletion must report the conflict without partial changes.");
        await AuthTestRequests.AssertSafeAsync(fixture, rejected);
        await Assert.That(await db.Organizations.AnyAsync(row => row.Id == org)).IsTrue();
        await Assert.That(await db.OrganizationMemberships.CountAsync(row => row.OrganizationId == org)).IsEqualTo(3);
        await Assert.That(await db.Users.AnyAsync(row => row.Id == data.Student)).IsTrue();
        await Assert.That(await db.Classrooms.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ClassroomMembers.CountAsync()).IsEqualTo(3);
        await Assert.That(await db.ClassAssignments.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ClassAssignmentStudents.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ProjectProvenances.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(2);
        await Assert.That(await db.ProjectAssignments.CountAsync()).IsEqualTo(2);
        await Assert.That(await db.ReviewSubmissions.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.ReviewDecisions.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.PublicationAccess.CountAsync()).IsEqualTo(1);
        await Assert.That(await db.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM retired_publication_ids").SingleAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Delete_RetiredPublicationCannotBeReusedByAnInsertAlreadyWaitingOnTheDeletion()
    {
        var pause = new CommitPause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause)));
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var (data, _) = await PublicationEndpointTests.PrepareAsync(fixture, assetOwner: admin);
        var retired = Guid.NewGuid();
        using var published = await PublishAsync(fixture, data.ProjectId, retired);
        await Assert.That(published.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var (other, _) = await PublicationEndpointTests.PrepareAsync(fixture, assetOwner: admin);
        var retained = Guid.NewGuid();
        using var otherPublished = await PublishAsync(fixture, other.ProjectId, retained);
        await Assert.That(otherPublished.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await fixture.SignInAsync(admin);
        var token = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var org = await db.OrganizationMemberships.Where(row => row.UserId == data.Student).Select(row => row.OrganizationId).SingleAsync();
        await using var connection = new NpgsqlConnection(db.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            INSERT INTO publications (id, project_id, published_by_id, source_revision, schema_version, document, asset_references, request_digest)
            SELECT @retired, project_id, published_by_id, source_revision, schema_version, document, asset_references, request_digest
            FROM publications WHERE id = @retained
            """, connection);
        command.Parameters.AddWithValue("retired", retired);
        command.Parameters.AddWithValue("retained", retained);
        pause.Armed = true;
        var deletion = DeleteAsync(fixture, org, token: token);
        Task<string?>? reuse = null;
        try
        {
            var holder = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            reuse = InsertAsync();
            await WaitBlockedAsync(db, connection.ProcessID, holder);
            pause.Release.TrySetResult();
            using var response = await deletion;
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await Assert.That(await reuse).IsEqualTo("CK_publication_id_retired");
            await Assert.That(await db.Publications.AnyAsync(row => row.Id == retired)).IsFalse();
        }
        finally
        {
            pause.Release.TrySetResult();
            using var drained = await deletion;
            if (reuse is not null) { await reuse; }
        }
        async Task<string?> InsertAsync()
        {
            try { await command.ExecuteNonQueryAsync(); return null; }
            catch (PostgresException error) { return error.ConstraintName; }
        }
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Delete_QueuedOrganizationsSerializeAndRecheckAdministrator(bool revoke)
    {
        var pause = new CommitPause();
        var locks = new LockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(pause, locks)));
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var secondAdmin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        using var secondClient = fixture.CreateClient();
        await fixture.SignInAsync(secondAdmin, secondClient);
        var firstMember = await fixture.CreateAccountAsync();
        var secondMember = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var firstOrg = await db.OrganizationMemberships.Where(row => row.UserId == firstMember).Select(row => row.OrganizationId).SingleAsync();
        var secondOrg = await db.OrganizationMemberships.Where(row => row.UserId == secondMember).Select(row => row.OrganizationId).SingleAsync();
        var firstToken = await fixture.GetCsrfAsync();
        var secondToken = await fixture.GetCsrfAsync(secondClient);
        pause.Armed = true;
        var first = DeleteAsync(fixture, firstOrg, token: firstToken);
        Task<HttpResponseMessage>? second = null;
        try
        {
            var holder = await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            locks.Armed = true;
            second = DeleteAsync(fixture, secondOrg, token: secondToken, client: secondClient);
            var waiter = await locks.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(db, waiter, holder);
            if (revoke) { await db.Users.Where(row => row.Id == secondAdmin).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false)); }
            pause.Release.TrySetResult();
            using var winner = await first;
            using var queued = await second;
            await Assert.That(winner.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
            await Assert.That(queued.StatusCode).IsEqualTo(revoke ? HttpStatusCode.Unauthorized : HttpStatusCode.NoContent);
            await Assert.That(await db.Organizations.AnyAsync(row => row.Id == firstOrg)).IsFalse();
            await Assert.That(await db.Organizations.AnyAsync(row => row.Id == secondOrg)).IsEqualTo(revoke);
            await Assert.That(await db.Users.AnyAsync(row => row.Id == secondMember)).IsEqualTo(revoke);
        }
        finally
        {
            pause.Release.TrySetResult();
            using var drained = await first;
            if (second is not null) { using var drainedSecond = await second; }
        }
    }

    [Test]
    [Arguments("roster", HttpStatusCode.NoContent)]
    [Arguments("assignment", HttpStatusCode.Created)]
    [Arguments("duplicate", HttpStatusCode.Created)]
    public async Task Delete_WaitsForInFlightWriterAndPurgesItsCommittedChanges(string operation, HttpStatusCode expected)
    {
        var rowLock = new RowLockPause(operation == "duplicate" ? "FROM projects WHERE id =" : "FROM classrooms WHERE id =");
        var deletion = new LockProbe();
        var failures = new CommandFailureProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(rowLock, deletion, failures)),
            environmentName: "Development");
        var data = await ReviewSubmissionEndpointTests.SeedAsync(fixture, late: false);
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        var teacherToken = await fixture.GetCsrfAsync(educator);
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Administrator));
        var adminToken = await fixture.GetCsrfAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await db.Classrooms.Where(row => row.Id == data.ClassroomId)
            .Select(row => row.OrganizationId).SingleAsync();
        var classes = $"/api/v1/classes/{data.ClassroomId:D}";
        using var remove = new HttpRequestMessage(HttpMethod.Delete, $"{classes}/members/{data.Student:D}");
        remove.Headers.Add("X-CSRF-TOKEN", teacherToken);
        rowLock.Armed = true;
        var write = operation switch
        {
            "roster" => educator.SendAsync(remove),
            "duplicate" => AuthTestRequests.PostAsync(fixture, $"/api/v1/projects/{data.ProjectId:D}/duplicate",
                new { title = "A copy", expectedRevision = 0 }, educator, teacherToken),
            "assignment" => AuthTestRequests.PostAsync(fixture, $"{classes}/assignments", new
            {
                requestId = Guid.NewGuid(),
                sourceProjectId = data.ProjectId,
                sourceRevision = 0,
                dueAtUnixSeconds = data.Due,
                title = "Another assignment",
                description = "Description",
                instructions = "Instructions",
                studentIds = new[] { data.Student },
            }, educator, teacherToken),
            _ => throw new ArgumentOutOfRangeException(nameof(operation)),
        };
        Task<HttpResponseMessage>? purge = null;
        try
        {
            var writer = await rowLock.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            deletion.Armed = true;
            purge = DeleteAsync(fixture, organization, token: adminToken);
            var queued = await deletion.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitBlockedAsync(db, queued, writer);
            rowLock.Release.TrySetResult();
            using var written = await write;
            using var deleted = await purge;
            await Assert.That(written.StatusCode).IsEqualTo(expected)
                .Because(failures.Failure ?? "The request already held its child row and must finish before deletion.");
            await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent)
                .Because(failures.Failure ?? "Deletion must see the changes committed by the class writer.");
            await Assert.That(await db.Organizations.AnyAsync(row => row.Id == organization)).IsFalse();
            await Assert.That(await db.ClassAssignments.AnyAsync(row => row.OrganizationId == organization)).IsFalse();
            await Assert.That(await db.Projects.AnyAsync(row => row.OrganizationId == organization)).IsFalse();
        }
        finally
        {
            rowLock.Release.TrySetResult();
            using var drained = await write;
            if (purge is not null) { using var drainedPurge = await purge; }
        }
    }

    private static async Task WaitBlockedAsync(ApplicationDbContext db, int waiter, int holder)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await db.Database.SqlQuery<bool>($"SELECT {holder} = ANY(pg_blocking_pids({waiter})) AS \"Value\"").SingleAsync(timeout.Token))
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private static string Path(Guid org) => $"/api/v1/admin/organizations/{org:D}";
    private static async Task<HttpResponseMessage> DeleteAsync(HttpsApplicationFixture fixture, Guid org,
        string name = "Synthetic organization", string? token = null, HttpClient? client = null)
    {
        client ??= fixture.Client;
        using var request = new HttpRequestMessage(HttpMethod.Delete, Path(org)) { Content = JsonContent.Create(new { confirmationName = name }) };
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(request);
    }
    private static Task<HttpResponseMessage> PublishAsync(HttpsApplicationFixture fixture, Guid project, Guid publication) =>
        AuthTestRequests.PostAsync(fixture, $"/api/v1/projects/{project}/publications", new
        {
            publicationId = publication,
            confirmedRevision = 0,
            intent = new { audience = "Authenticated", viewerIds = Array.Empty<Guid>() },
        });
    private static async Task AssertConstraintAsync(ApplicationDbContext db, string sql, string constraint)
    {
        PostgresException? rejected = null;
        try { await db.Database.ExecuteSqlRawAsync(sql); }
        catch (PostgresException exception) { rejected = exception; }
        await Assert.That(rejected?.ConstraintName).IsEqualTo(constraint);
    }

    private sealed class CommandFailureProbe : DbCommandInterceptor
    {
        public string? Failure;
        public override Task CommandFailedAsync(DbCommand command, CommandErrorEventData eventData, CancellationToken cancellationToken = default)
        {
            if (eventData.Exception is PostgresException error) { Failure = $"{error.SqlState}: {error.MessageText} ({error.ConstraintName})"; }
            return Task.CompletedTask;
        }
    }

    private sealed class CommitPause : DbTransactionInterceptor
    {
        public bool Armed;
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

    private sealed class RowLockPause(string target) : DbCommandInterceptor
    {
        public bool Armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
            DbDataReader result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains(target, StringComparison.Ordinal)
                && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal))
            {
                Armed = false;
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }

    private sealed class LockProbe : DbCommandInterceptor
    {
        public bool Armed;
        public TaskCompletionSource<int> Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("LOCK TABLE", StringComparison.Ordinal))
            {
                Armed = false;
                Entered.TrySetResult(((NpgsqlConnection)command.Connection!).ProcessID);
            }
            return ValueTask.FromResult(result);
        }
    }
}
