using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(CreationReceiptTests))]
public sealed class CreationReceiptTests
{
    [Test]
    [Arguments("project")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ExpiryAfterSuccessfulCommitReturnsMarked204AndReauthenticationRecoversOriginalCreation(string kind)
    {
        var expiry = new CommitExpiry();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(expiry)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var source = kind == "duplicate" ? await SeedProjectAsync(fixture) : Guid.Empty;
        var body = Body(kind, Guid.NewGuid());
        var token = await fixture.GetCsrfAsync();
        expiry.After = () => fixture.Clock.Advance(TimeSpan.FromHours(9));
        using var withheld = await AuthTestRequests.PostAsync(fixture, Path(kind, source), body, token: token);
        await Assert.That(withheld.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        await Assert.That(withheld.Headers.GetValues("X-Spatia-Write-Outcome").Single()).IsEqualTo("committed");
        await Assert.That(await withheld.Content.ReadAsStringAsync()).IsEqualTo("");
        await Assert.That(withheld.Headers.Location).IsNull();
        await Assert.That(withheld.Headers.WwwAuthenticate.Count).IsEqualTo(0);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var receipt = await db.Set<CreationReceipt>().SingleAsync(row => row.Kind == kind);
        var id = Id(kind, JsonSerializer.Deserialize<JsonElement>(receipt.ResponseJson!));
        await Assert.That(receipt.ResourceId).IsEqualTo(id);
        await fixture.SignInAsync(actor);
        using var recovered = await AuthTestRequests.PostAsync(fixture, Path(kind, source), body);
        await Assert.That(recovered.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await recovered.Content.ReadAsStringAsync()).IsEqualTo(receipt.ResponseJson);
        await Assert.That(recovered.Headers.Location?.OriginalString).IsEqualTo(CreationReceipts.Location(kind, id));
        await Assert.That(await db.Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(1);
        await Assert.That(kind == "class" ? await db.Classrooms.CountAsync() : await db.Projects.CountAsync()).IsEqualTo(kind == "duplicate" ? 2 : 1);
    }

    [Test]
    [Arguments("project")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ConcurrentAndReopenedRetriesReturnOneOriginalReceipt(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var source = kind == "duplicate" ? await SeedProjectAsync(fixture) : Guid.Empty;
        var operation = Guid.NewGuid();
        var token = await fixture.GetCsrfAsync();
        var path = Path(kind, source);
        var body = Body(kind, operation);
        var responses = await Task.WhenAll(AuthTestRequests.PostAsync(fixture, path, body, token: token),
            AuthTestRequests.PostAsync(fixture, path, body, token: token));
        using var created = responses.Single(response => response.StatusCode == HttpStatusCode.Created);
        using var replay = responses.Single(response => response.StatusCode == HttpStatusCode.OK);
        var original = await created.Content.ReadAsStringAsync();
        var id = Id(kind, JsonSerializer.Deserialize<JsonElement>(original));
        var location = $"/api/v1/{(kind == "class" ? "classes" : "projects")}/{id:D}";
        await Assert.That(created.Headers.Location?.OriginalString).IsEqualTo(location);
        await Assert.That(replay.Headers.Location?.OriginalString).IsEqualTo(location);
        await Assert.That(await replay.Content.ReadAsStringAsync()).IsEqualTo(original);

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (kind == "class")
            {
                await db.Classrooms.Where(row => row.Id == id).ExecuteUpdateAsync(set => set.SetProperty(row => row.Name, "Later name"));
            }
            else
            {
                await db.Projects.Where(row => row.Id == id || row.Id == source).ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 3));
            }
        }
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);
        using var recovered = await AuthTestRequests.PostAsync(reopened, path, body);
        await Assert.That(recovered.StatusCode).IsEqualTo(HttpStatusCode.OK);
        await Assert.That(await recovered.Content.ReadAsStringAsync()).IsEqualTo(original);
        await Assert.That(recovered.Headers.CacheControl?.NoStore).IsTrue();
        using var changed = await AuthTestRequests.PostAsync(reopened, path, Body(kind, operation, "Different"));
        await AuthTestRequests.AssertProblemAsync(changed, HttpStatusCode.Conflict, "operation_conflict");
        using var independent = await AuthTestRequests.PostAsync(reopened, path, Body(kind, Guid.NewGuid(), revision: kind == "duplicate" ? 3 : 0));
        await Assert.That(independent.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await Assert.That(Id(kind, await independent.Content.ReadFromJsonAsync<JsonElement>())).IsNotEqualTo(id);
        await using var verify = reopened.Database.Services.CreateAsyncScope();
        await Assert.That(await verify.ServiceProvider.GetRequiredService<ApplicationDbContext>().Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(2);
    }

    [Test]
    public async Task KeysAreActorScopedAndCannotChangeKindOrDuplicateSource()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var operation = Guid.NewGuid();
        using var project = await AuthTestRequests.PostAsync(fixture, Path("project"), Body("project", operation));
        await Assert.That(project.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var wrongKind = await AuthTestRequests.PostAsync(fixture, Path("class"), Body("class", operation));
        await AuthTestRequests.AssertProblemAsync(wrongKind, HttpStatusCode.Conflict, "operation_conflict");
        var firstSource = await SeedProjectAsync(fixture);
        var secondSource = await SeedProjectAsync(fixture);
        var duplicateOperation = Guid.NewGuid();
        using var duplicate = await AuthTestRequests.PostAsync(fixture, Path("duplicate", firstSource), Body("duplicate", duplicateOperation));
        await Assert.That(duplicate.StatusCode).IsEqualTo(HttpStatusCode.Created);
        using var wrongTarget = await AuthTestRequests.PostAsync(fixture, Path("duplicate", secondSource), Body("duplicate", duplicateOperation));
        await AuthTestRequests.AssertProblemAsync(wrongTarget, HttpStatusCode.Conflict, "operation_conflict");
        using var other = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator), other);
        using var sameKey = await AuthTestRequests.PostAsync(fixture, Path("project"), Body("project", operation), other);
        await Assert.That(sameKey.StatusCode).IsEqualTo(HttpStatusCode.Created);
    }

    [Test]
    [Arguments("project")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ReplaysRevalidateCurrentResourceAuthorityAndNeverRecreateMissingResources(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var source = kind == "duplicate" ? await SeedProjectAsync(fixture) : Guid.Empty;
        var operation = Guid.NewGuid();
        var path = Path(kind, source);
        var body = Body(kind, operation);
        using var first = await AuthTestRequests.PostAsync(fixture, path, body);
        await Assert.That(first.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var id = Id(kind, await first.Content.ReadFromJsonAsync<JsonElement>());
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        if (kind == "class")
        {
            await db.ClassroomMembers.Where(row => row.ClassroomId == id).ExecuteDeleteAsync();
        }
        else
        {
            await db.ProjectAssignments.Where(row => row.ProjectId == (kind == "duplicate" ? source : id)).ExecuteDeleteAsync();
        }
        using var revoked = await AuthTestRequests.PostAsync(fixture, path, body);
        await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        if (kind == "duplicate")
        {
            db.ProjectAssignments.Add(new ProjectAssignment { ProjectId = source, UserId = actor, CanEdit = true, CanManage = true });
            await db.SaveChangesAsync();
            await db.ProjectAssignments.Where(row => row.ProjectId == id).ExecuteDeleteAsync();
            using var copyRevoked = await AuthTestRequests.PostAsync(fixture, path, body);
            await Assert.That(copyRevoked.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }
        if (kind == "class") { await db.Classrooms.Where(row => row.Id == id).ExecuteDeleteAsync(); }
        else
        {
            await db.ProjectAssignments.Where(row => row.ProjectId == id).ExecuteDeleteAsync();
            await db.Projects.Where(row => row.Id == id).ExecuteDeleteAsync();
        }
        using var missing = await AuthTestRequests.PostAsync(fixture, path, body);
        await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await Assert.That(await db.Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(1);
    }

    [Test]
    [Arguments("project", false)]
    [Arguments("duplicate", false)]
    [Arguments("class", false)]
    [Arguments("project", true)]
    [Arguments("duplicate", true)]
    [Arguments("class", true)]
    public async Task FailedCommitRollsBackAndLostResponseReplaysTheCommittedResult(string kind, bool afterCommit)
    {
        var failure = new CommitOutcomeFailure(afterCommit);
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)), environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var source = kind == "duplicate" ? await SeedProjectAsync(fixture) : Guid.Empty;
        var operation = Guid.NewGuid();
        var body = Body(kind, operation);
        var token = await fixture.GetCsrfAsync();
        failure.Armed = true;
        using var lost = await AuthTestRequests.PostAsync(fixture, Path(kind, source), body, token: token);
        await Assert.That(lost.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await db.Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(afterCommit ? 1 : 0);
        using var retry = await AuthTestRequests.PostAsync(fixture, Path(kind, source), body, token: token);
        await Assert.That(retry.StatusCode).IsEqualTo(afterCommit ? HttpStatusCode.OK : HttpStatusCode.Created);
        var receipt = await db.Set<CreationReceipt>().SingleAsync(row => row.Kind == kind);
        await Assert.That(Id(kind, await retry.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(receipt.ResourceId);
        await Assert.That(await db.Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(1);
        await Assert.That(kind == "class" ? await db.Classrooms.CountAsync() : await db.Projects.CountAsync()).IsEqualTo(kind == "duplicate" ? 2 : 1);
    }

    [Test]
    [Arguments("project")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task ExplicitDistinctKeysKeepCreatingAndAllCreationsExposeCanonicalLocation(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var source = kind == "duplicate" ? await SeedProjectAsync(fixture) : Guid.Empty;
        var ids = new List<Guid>();
        for (var i = 0; i < 2; i++)
        {
            using var response = await AuthTestRequests.PostAsync(fixture, Path(kind, source), Body(kind, Guid.NewGuid()));
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
            var id = Id(kind, await response.Content.ReadFromJsonAsync<JsonElement>());
            ids.Add(id);
            await Assert.That(response.Headers.Location?.OriginalString).IsEqualTo(CreationReceipts.Location(kind, id));
        }
        await Assert.That(ids.Distinct().Count()).IsEqualTo(2);
        using var empty = await AuthTestRequests.PostAsync(fixture, Path(kind, source), Body(kind, Guid.Empty));
        await Assert.That(empty.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(2);
    }

    [Test]
    [Arguments("project", false)]
    [Arguments("duplicate", false)]
    [Arguments("class", false)]
    [Arguments("project", true)]
    [Arguments("duplicate", true)]
    [Arguments("class", true)]
    public async Task FreshCreationRevalidatesRevokedActorAfterLockWaitAndPreparation(string kind, bool duringPreparation)
    {
        var keyAttempt = new KeyAttempt();
        var preparation = new PreparationPause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(keyAttempt, preparation)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var source = kind == "duplicate" ? await SeedProjectAsync(fixture) : Guid.Empty;
        var operation = Guid.NewGuid();
        var token = await fixture.GetCsrfAsync();
        await using var holder = fixture.Database.Services.CreateAsyncScope();
        var db = holder.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await db.Database.BeginTransactionAsync();
        if (duringPreparation) { preparation.Armed = true; }
        else
        {
            await CreationReceipts.FindAsync(db, actor, operation, CancellationToken.None);
            keyAttempt.Armed = true;
        }
        var pending = AuthTestRequests.PostAsync(fixture, Path(kind, source), Body(kind, operation), token: token);
        try
        {
            await (duringPreparation ? preparation.Entered.Task : keyAttempt.Entered.Task).WaitAsync(TimeSpan.FromSeconds(10));
            await db.Users.Where(row => row.Id == actor).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
            await transaction.CommitAsync();
        }
        finally { preparation.Release.TrySetResult(); }
        using var rejected = await pending;
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await Assert.That(await db.Set<CreationReceipt>().CountAsync(row => row.Kind == kind)).IsEqualTo(0);
        await Assert.That(kind == "class" ? await db.Classrooms.CountAsync() : await db.Projects.CountAsync()).IsEqualTo(kind == "duplicate" ? 1 : 0);
    }

    [Test]
    [Arguments("role")]
    [Arguments("organization")]
    public async Task PreparedProjectCannotCommitWithEarlierRoleOrOrganization(string change)
    {
        var preparation = new PreparationPause();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(preparation)), environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var token = await fixture.GetCsrfAsync();
        preparation.Armed = true;
        var pending = AuthTestRequests.PostAsync(fixture, Path("project"), Body("project", Guid.NewGuid()), token: token);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        try
        {
            await preparation.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await using var transaction = await db.Database.BeginTransactionAsync();
            var organization = await db.OrganizationMemberships.Where(row => row.UserId == actor).Select(row => row.OrganizationId).SingleAsync();
            if (change == "role")
            {
                await db.OrganizationMemberships.Where(row => row.UserId == actor).ExecuteDeleteAsync();
                await db.UserRoles.Where(row => row.UserId == actor).ExecuteDeleteAsync();
                db.UserRoles.Add(new IdentityUserRole<Guid> { UserId = actor, RoleId = ApplicationRoles.CreatorId });
                db.OrganizationMemberships.Add(new OrganizationMembership { OrganizationId = organization, UserId = actor, RoleId = ApplicationRoles.CreatorId });
            }
            else
            {
                var destination = new Organization { Id = Guid.NewGuid(), Name = "New organization" };
                db.Organizations.Add(destination);
                await db.SaveChangesAsync();
                await db.OrganizationMemberships.Where(row => row.UserId == actor).ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, destination.Id));
            }
            await db.SaveChangesAsync();
            await transaction.CommitAsync();
        }
        finally { preparation.Release.TrySetResult(); }
        using var rejected = await pending;
        await Assert.That(rejected.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        await Assert.That(await db.Projects.CountAsync()).IsEqualTo(0);
        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task OrganizationPurgeRedactsSurvivingAdminReceiptAndKeepsTheKeyReserved()
    {
        var failure = new AdministrationCommitInterceptor();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(failure)), environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var admin = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        await fixture.SignInAsync(educator);
        using var project = await AuthTestRequests.PostAsync(fixture, Path("project"), Body("project", Guid.NewGuid()));
        await Assert.That(project.StatusCode).IsEqualTo(HttpStatusCode.Created);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await (from membership in db.OrganizationMemberships
                                  join org in db.Organizations on membership.OrganizationId equals org.Id
                                  where membership.UserId == educator
                                  select org).SingleAsync();
        await fixture.SignInAsync(admin);
        var operationId = Guid.NewGuid();
        var body = new { name = "Private class name", orgId = organization.Id, operationId };
        using var created = await AuthTestRequests.PostAsync(fixture, Path("class"), body);
        await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created);
        var original = await created.Content.ReadAsStringAsync();
        var token = await fixture.GetCsrfAsync();
        failure.Arm();
        using (var deletion = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/admin/organizations/{organization.Id:D}")
        { Content = JsonContent.Create(new { confirmationName = organization.Name }) })
        {
            deletion.Headers.Add("X-CSRF-TOKEN", token);
            using var rolledBack = await fixture.Client.SendAsync(deletion);
            await Assert.That(rolledBack.StatusCode).IsEqualTo(HttpStatusCode.InternalServerError);
        }
        await Assert.That((await db.Set<CreationReceipt>().AsNoTracking().SingleAsync(row => row.ActorId == admin)).ResponseJson).IsEqualTo(original);
        using (var deletion = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/admin/organizations/{organization.Id:D}")
        { Content = JsonContent.Create(new { confirmationName = organization.Name }) })
        {
            deletion.Headers.Add("X-CSRF-TOKEN", token);
            using var deleted = await fixture.Client.SendAsync(deletion);
            await Assert.That(deleted.StatusCode).IsEqualTo(HttpStatusCode.NoContent);
        }
        var tombstone = await db.Set<CreationReceipt>().AsNoTracking().SingleAsync();
        await Assert.That(tombstone.ActorId).IsEqualTo(admin);
        await Assert.That(tombstone.ResponseJson).IsNull();
        using var replay = await AuthTestRequests.PostAsync(fixture, Path("class"), body);
        await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        var other = new Organization { Id = Guid.NewGuid(), Name = "Other organization" };
        db.Organizations.Add(other);
        await db.SaveChangesAsync();
        using var repurposed = await AuthTestRequests.PostAsync(fixture, Path("class"), new { name = body.name, orgId = other.Id, operationId });
        await Assert.That(repurposed.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await Assert.That(await db.Classrooms.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task MigrationUpgradeRollbackAndReapplyPreserveResourcesAndMatchModel()
    {
        const string previous = "20261114115659_AddAssetRemovalReceipts";
        await using var fixture = await PostgresAccountFixture.CreateAsync(previous);
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var actor = new ApplicationUser { Id = Guid.NewGuid(), UserName = "creation-upgrade", NormalizedUserName = "CREATION-UPGRADE" };
        var organization = new Organization { Id = Guid.NewGuid(), Name = "Existing organization" };
        var classroom = new Classroom { Id = Guid.NewGuid(), OrganizationId = organization.Id, Name = "Existing class" };
        db.Users.Add(actor);
        db.Organizations.Add(organization);
        db.Classrooms.Add(classroom);
        await db.SaveChangesAsync();
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync();
        await Assert.That(db.Database.HasPendingModelChanges()).IsFalse();
        var operation = Guid.NewGuid();
        CreationReceipts.Stage(db, actor.Id, operation, "project", new byte[32], Guid.NewGuid(), new { id = actor.Id });
        await db.SaveChangesAsync();
        await Assert.ThrowsAsync<PostgresException>(() => migrator.MigrateAsync(previous));
        await Assert.That((await db.Set<CreationReceipt>().AsNoTracking().SingleAsync()).OperationId).IsEqualTo(operation);
        await db.Set<CreationReceipt>().ExecuteDeleteAsync();
        await migrator.MigrateAsync(previous);
        await Assert.That(await db.Database.SqlQuery<bool>($"SELECT to_regclass('creation_receipts') IS NULL AS \"Value\"").SingleAsync()).IsTrue();
        await Assert.That(await db.Users.CountAsync()).IsEqualTo(1);
        await Assert.That((await db.Classrooms.AsNoTracking().SingleAsync()).Name).IsEqualTo(classroom.Name);
        await migrator.MigrateAsync();
        db.ChangeTracker.Clear();
        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
        await PostgresAccountFixture.ExecuteMigrationScriptAsync(db, migrator.GenerateScript(options: MigrationsSqlGenerationOptions.Idempotent));
        await Assert.That(await db.Users.CountAsync()).IsEqualTo(1);
        await Assert.That((await db.Classrooms.AsNoTracking().SingleAsync()).Name).IsEqualTo(classroom.Name);
        await Assert.That(db.Database.HasPendingModelChanges()).IsFalse();
    }

    private static object Body(string kind, Guid? operationId, string title = "Same name", long revision = 0) => kind switch
    {
        "class" => new { name = title, operationId },
        "duplicate" => new { expectedRevision = revision, title, operationId },
        _ => new { title, operationId },
    };

    private static string Path(string kind, Guid source = default) => kind switch
    {
        "class" => "/api/v1/classes",
        "duplicate" => $"/api/v1/projects/{source:D}/duplicate",
        _ => "/api/v1/projects",
    };

    private static Guid Id(string kind, JsonElement body) => body.GetProperty(kind == "class" ? "id" : "projectId").GetGuid();

    private static async Task<Guid> SeedProjectAsync(HttpsApplicationFixture fixture)
    {
        using var response = await AuthTestRequests.PostAsync(fixture, Path("project"), Body("project", Guid.NewGuid()));
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.Created);
        return Id("project", await response.Content.ReadFromJsonAsync<JsonElement>());
    }

    private sealed class CommitOutcomeFailure(bool afterCommit) : DbTransactionInterceptor
    {
        internal bool Armed { get; set; }

        public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Armed && !afterCommit) { Armed = false; throw new NpgsqlException("Synthetic creation commit failure."); }
            return ValueTask.FromResult(result);
        }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
        {
            if (Armed && afterCommit) { Armed = false; throw new NpgsqlException("Synthetic lost creation response."); }
            return Task.CompletedTask;
        }
    }

    private sealed class KeyAttempt : DbCommandInterceptor
    {
        internal bool Armed { get; set; }
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Armed && command.CommandText.Contains("pg_advisory_xact_lock", StringComparison.Ordinal))
            {
                Armed = false;
                Entered.TrySetResult();
            }
            return ValueTask.FromResult(result);
        }
    }

    private sealed class CommitExpiry : DbTransactionInterceptor
    {
        internal Action? After;

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Exchange(ref After, null)?.Invoke();
            return Task.CompletedTask;
        }
    }

    private sealed class PreparationPause : SaveChangesInterceptor
    {
        internal bool Armed { get; set; }
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            if (Armed)
            {
                Armed = false;
                Entered.TrySetResult();
                await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            return result;
        }
    }
}
