using System.Data;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectAccessTests
{
    private const string BodyMarker = "private-project-body-not-for-denied-readers";

    [Test]
    public async Task ProjectAccess_Anonymous_DoesNotReturnProjectData()
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture);
        await AssertDeniedAsync(await ReadAsync(fixture, seeded.ProjectId), ProjectAccessFailure.AuthenticationRequired);
    }

    [Test]
    [Arguments("missing-feature")]
    [Arguments("duplicate-id")]
    [Arguments("malformed-id")]
    [Arguments("changed-id")]
    [Arguments("changed-stamp")]
    public async Task ProjectAccess_AuthenticatedPrincipalCannotReplaceValidatedSession(string mutation)
    {
        await using var fixture = await CreateFixtureAsync((context, access, _, id) =>
        {
            var principal = context.User.Clone();
            var identity = (ClaimsIdentity)principal.Identity!;
            if (mutation == "missing-feature")
            {
                context = new DefaultHttpContext { User = principal };
            }
            else
            {
                var type = mutation == "changed-stamp" ? "AspNet.Identity.SecurityStamp" : ClaimTypes.NameIdentifier;
                if (mutation != "duplicate-id")
                {
                    if (identity.FindFirst(type) is { } existing)
                    {
                        identity.RemoveClaim(existing);
                    }
                }
                identity.AddClaim(new Claim(type, mutation == "malformed-id" ? "not-a-guid" : Guid.NewGuid().ToString("D")));
                context.User = principal;
            }
            return access.ReadAsync(context, id);
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        await AssertDeniedAsync(await ReadAsync(fixture, seeded.ProjectId), ProjectAccessFailure.AuthenticationRequired);
    }

    [Test]
    [Arguments("disabled", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("stamp", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("membership", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("organization", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("role", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("forced", ProjectAccessFailure.PasswordChangeRequired)]
    public async Task ProjectAccess_AuthorityChangedAfterCookieValidation_IsRechecked(
        string mutation, ProjectAccessFailure failure)
    {
        var gate = new Pause();
        await using var fixture = await CreateFixtureAsync(async (context, access, _, id) =>
        {
            await gate.WaitAsync(context.RequestAborted);
            return await access.ReadAsync(context, id, context.RequestAborted);
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        using var response = await DuringPauseAsync(fixture.Client.GetAsync(Path(seeded.ProjectId)), gate, async () =>
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync(user => user.Id == seeded.ActorId);
            switch (mutation)
            {
                case "disabled": user.IsActive = false; break;
                case "stamp": user.SecurityStamp = Guid.NewGuid().ToString("N"); break;
                case "membership":
                    database.OrganizationMemberships.Remove(await database.OrganizationMemberships.SingleAsync());
                    break;
                case "organization": (await database.Organizations.SingleAsync()).IsActive = false; break;
                case "role":
                    (await database.Roles.SingleAsync(role => role.Id == ApplicationRoles.CreatorId)).Name = "ChangedCreator";
                    break;
                case "forced": user.MustChangePassword = true; break;
            }
            await database.SaveChangesAsync();
        });
        await AssertDeniedAsync(await JsonAsync(response), failure);
    }

    [Test]
    [Arguments(ApplicationRoles.Creator, true, false, true, false, true, false)]
    [Arguments(ApplicationRoles.Creator, true, false, false, false, false, false)]
    [Arguments(ApplicationRoles.Educator, false, true, false, true, true, false)]
    [Arguments(ApplicationRoles.Administrator, false, false, false, true, true, true)]
    public async Task ProjectAccess_ServerRoleAndAssignmentDetermineEffectivePermissions(string role,
        bool edit, bool manage, bool publish, bool expectedManage, bool expectedPublish, bool inactiveTarget)
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture, role, edit, manage, publish, inactiveTarget);
        await fixture.SignInAsync(seeded.ActorId, forgedRole: ApplicationRoles.Administrator);
        var snapshot = (await ReadAsync(fixture, seeded.ProjectId)).GetProperty("snapshot");
        await Assert.That(snapshot.GetProperty("actorId").GetGuid()).IsEqualTo(seeded.ActorId);
        await Assert.That(snapshot.GetProperty("canEdit").GetBoolean()).IsTrue();
        await Assert.That(snapshot.GetProperty("canManage").GetBoolean()).IsEqualTo(expectedManage);
        await Assert.That(snapshot.GetProperty("canPublish").GetBoolean()).IsEqualTo(expectedPublish);
        await Assert.That(snapshot.GetProperty("unvalidatedDocumentJson").GetString()!.Contains(BodyMarker)).IsTrue();
    }

    [Test]
    [Arguments("other-student")]
    [Arguments("other-organization")]
    [Arguments("publish-only")]
    [Arguments("manage-only-creator")]
    [Arguments("edit-only-educator")]
    [Arguments("all-false")]
    [Arguments("missing-project")]
    public async Task ProjectAccess_IdsImportedHintsAndInsufficientFlags_DoNotGrantAccess(string scenario)
    {
        var role = scenario == "edit-only-educator" ? ApplicationRoles.Educator : ApplicationRoles.Creator;
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture, role);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var assignment = await database.ProjectAssignments.SingleAsync();
            assignment.CanEdit = scenario == "edit-only-educator" || scenario == "other-organization";
            assignment.CanManage = scenario == "manage-only-creator";
            assignment.CanPublish = scenario == "publish-only";
            if (scenario == "other-student")
            {
                database.ProjectAssignments.Remove(assignment);
                var other = new ApplicationUser
                {
                    Id = Guid.NewGuid(),
                    UserName = "other-student",
                    NormalizedUserName = "OTHER-STUDENT",
                };
                database.Users.Add(other);
                database.ProjectAssignments.Add(new ProjectAssignment
                {
                    ProjectId = seeded.ProjectId,
                    UserId = other.Id,
                    CanEdit = true,
                });
            }
            if (scenario == "other-organization")
            {
                var other = new Organization { Id = Guid.NewGuid(), Name = "Other school" };
                database.Organizations.Add(other);
                (await database.Projects.SingleAsync()).OrganizationId = other.Id;
            }
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(seeded.ActorId, forgedRole: ApplicationRoles.Administrator);
        await AssertDeniedAsync(await ReadAsync(fixture,
            scenario == "missing-project" ? Guid.NewGuid() : seeded.ProjectId), ProjectAccessFailure.NotFound);
    }

    [Test]
    public async Task ProjectAccess_ReadSnapshotIsCoherentAndNextReadSeesRevocation()
    {
        var gate = new ProjectQueryPause();
        await using var fixture = await CreateFixtureAsync(configure: builder =>
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)));
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        gate.Arm();
        using var response = await DuringPauseAsync(fixture.Client.GetAsync(Path(seeded.ProjectId)), gate.Pause, async () =>
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await using var transaction = await database.Database.BeginTransactionAsync();
            (await database.Users.SingleAsync()).IsActive = false;
            var project = await database.Projects.SingleAsync();
            project.Revision = 1;
            project.DocumentJson = Document(project.Id, "new denied body");
            await database.SaveChangesAsync();
            await transaction.CommitAsync();
        });
        var snapshot = (await JsonAsync(response)).GetProperty("snapshot");
        await Assert.That(snapshot.GetProperty("revision").GetInt64()).IsEqualTo(0L);
        await Assert.That(snapshot.GetProperty("unvalidatedDocumentJson").GetString()!.Contains(BodyMarker)).IsTrue();
        await AssertDeniedAsync(await ReadAsync(fixture, seeded.ProjectId), ProjectAccessFailure.AuthenticationRequired);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ProjectAccess_OriginalCookieCutoffReachedDuringRead_ReturnsNoData(bool beforeBodyQuery)
    {
        var gate = new ProjectQueryPause();
        var entry = new Pause();
        await using var fixture = await CreateFixtureAsync(async (context, access, _, id) =>
        {
            if (!beforeBodyQuery)
            {
                await entry.WaitAsync(context.RequestAborted);
            }
            return await access.ReadAsync(context, id, context.RequestAborted);
        }, builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(gate)));
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var cutoff = Cutoff(fixture);
        if (beforeBodyQuery)
        {
            gate.Arm();
        }
        using var response = await DuringPauseAsync(fixture.Client.GetAsync(Path(seeded.ProjectId)),
            beforeBodyQuery ? gate.Pause : entry, () =>
            {
                fixture.Clock.Set(cutoff);
                return Task.CompletedTask;
            });
        await AssertDeniedAsync(await JsonAsync(response), ProjectAccessFailure.AuthenticationRequired);
    }

    [Test]
    public async Task ProjectAccess_ActiveCallerTransactionIsRejectedAndTrackedDataIsIgnored()
    {
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            await using (var transaction = await database.Database.BeginTransactionAsync())
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => access.ReadAsync(context, id));
            }
            var stale = await database.Projects.SingleAsync();
            stale.DocumentJson = Document(id, "uncommitted tracked value");
            stale.Revision = 123;
            return await access.ReadAsync(context, id);
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var snapshot = (await ReadAsync(fixture, seeded.ProjectId)).GetProperty("snapshot");
        await Assert.That(snapshot.GetProperty("revision").GetInt64()).IsEqualTo(0L);
        await Assert.That(snapshot.GetProperty("unvalidatedDocumentJson").GetString()!.Contains(BodyMarker)).IsTrue();
    }

    [Test]
    [Arguments(ApplicationRoles.Creator)]
    [Arguments(ApplicationRoles.Educator)]
    [Arguments(ApplicationRoles.Administrator)]
    public async Task ProjectAccess_ArchivedReadRetainsManagementButNeverEditOrPublish(string role)
    {
        await using var fixture = await CreateFixtureAsync();
        var seeded = await SeedAsync(fixture, role, manage: role == ApplicationRoles.Educator, publish: true);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            (await database.Projects.SingleAsync()).IsArchived = true;
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(seeded.ActorId);
        var snapshot = (await ReadAsync(fixture, seeded.ProjectId)).GetProperty("snapshot");
        await Assert.That(snapshot.GetProperty("isArchived").GetBoolean()).IsTrue();
        await Assert.That(snapshot.GetProperty("canEdit").GetBoolean()).IsFalse();
        await Assert.That(snapshot.GetProperty("canPublish").GetBoolean()).IsFalse();
        await Assert.That(snapshot.GetProperty("canManage").GetBoolean()).IsEqualTo(role != ApplicationRoles.Creator);
    }

    [Test]
    [Arguments(ApplicationRoles.Creator, false, ProjectLockPurpose.EditDraft, null)]
    [Arguments(ApplicationRoles.Creator, false, ProjectLockPurpose.ManageAssignments, "OperationForbidden")]
    [Arguments(ApplicationRoles.Educator, false, ProjectLockPurpose.ManageAssignments, null)]
    [Arguments(ApplicationRoles.Educator, true, ProjectLockPurpose.ManageAssignments, "ProjectReadOnly")]
    [Arguments(ApplicationRoles.Educator, true, ProjectLockPurpose.ChangeArchiveState, null)]
    [Arguments(ApplicationRoles.Creator, true, ProjectLockPurpose.ChangeArchiveState, "OperationForbidden")]
    [Arguments(ApplicationRoles.Creator, true, ProjectLockPurpose.EditDraft, "ProjectReadOnly")]
    public async Task ProjectAccess_LockPurposeEnforcesRoleAndArchivePolicy(string role, bool archived,
        ProjectLockPurpose purpose, string? failure)
    {
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            var result = await access.LockAsync(context, id, purpose, context.RequestAborted);
            await transaction.RollbackAsync();
            return result;
        });
        var seeded = await SeedAsync(fixture, role, manage: role == ApplicationRoles.Educator);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            (await database.Projects.SingleAsync()).IsArchived = archived;
            await database.SaveChangesAsync();
        }
        await fixture.SignInAsync(seeded.ActorId);
        var result = await ReadAsync(fixture, seeded.ProjectId);
        if (failure is not null)
        {
            await AssertDeniedAsync(result, Enum.Parse<ProjectAccessFailure>(failure));
        }
        else
        {
            await Assert.That(result.GetProperty("failure").ValueKind).IsEqualTo(JsonValueKind.Null);
            await Assert.That(result.GetProperty("snapshot").GetProperty("projectId").GetGuid()).IsEqualTo(seeded.ProjectId);
        }
        await AssertStoredAsync(fixture, seeded.ProjectId, archived);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ProjectAccess_LockRequiresCallerReadCommittedTransaction(bool wrongIsolation)
    {
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            if (wrongIsolation)
            {
                await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead);
                await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    access.LockAsync(context, id, ProjectLockPurpose.EditDraft));
            }
            else
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    access.LockAsync(context, id, ProjectLockPurpose.EditDraft));
            }
            return await access.ReadAsync(context, id);
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var result = await ReadAsync(fixture, seeded.ProjectId);
        await Assert.That(result.GetProperty("failure").ValueKind).IsEqualTo(JsonValueKind.Null);
        await AssertStoredAsync(fixture, seeded.ProjectId);
    }

    [Test]
    [Arguments("assignment", ProjectAccessFailure.NotFound)]
    [Arguments("archive", ProjectAccessFailure.ProjectReadOnly)]
    [Arguments("stamp", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("forced", ProjectAccessFailure.PasswordChangeRequired)]
    [Arguments("expiry", ProjectAccessFailure.AuthenticationRequired)]
    public async Task ProjectAccess_LockWaitRechecksCommittedAuthorityArchiveAndOriginalCutoff(
        string change, ProjectAccessFailure failure)
    {
        var waiter = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            waiter.TrySetResult(((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID);
            var result = await access.LockAsync(context, id, ProjectLockPurpose.EditDraft, context.RequestAborted);
            await transaction.RollbackAsync();
            return result;
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        await using var holderScope = fixture.Database.Services.CreateAsyncScope();
        var holder = holderScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var held = await holder.Database.BeginTransactionAsync();
        await LockProjectAsync(holder, seeded.ProjectId);
        var blocker = ((NpgsqlConnection)holder.Database.GetDbConnection()).ProcessID;
        var request = fixture.Client.GetAsync(Path(seeded.ProjectId));
        HttpResponseMessage? response = null;
        try
        {
            await WaitBlockedAsync(fixture, await waiter.Task.WaitAsync(TimeSpan.FromSeconds(10)), blocker);
            switch (change)
            {
                case "assignment": (await holder.ProjectAssignments.SingleAsync()).CanEdit = false; break;
                case "archive": (await holder.Projects.SingleAsync()).IsArchived = true; break;
                case "stamp": (await holder.Users.SingleAsync()).SecurityStamp = Guid.NewGuid().ToString("N"); break;
                case "forced": (await holder.Users.SingleAsync()).MustChangePassword = true; break;
                case "expiry": fixture.Clock.Set(Cutoff(fixture)); break;
            }
            await holder.SaveChangesAsync();
            await held.CommitAsync();
            response = await request;
            await AssertDeniedAsync(await JsonAsync(response), failure);
        }
        finally
        {
            await held.DisposeAsync();
            response ??= await request;
            response.Dispose();
        }
        await AssertStoredAsync(fixture, seeded.ProjectId, change == "archive");
    }

    [Test]
    public async Task ProjectAccess_LockMissingRowReturnsNoSnapshot()
    {
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            return await access.LockAsync(context, id, ProjectLockPurpose.EditDraft);
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        await AssertDeniedAsync(await ReadAsync(fixture, Guid.NewGuid()), ProjectAccessFailure.NotFound);
        await AssertStoredAsync(fixture, seeded.ProjectId);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ProjectAccess_AuthorizedCallerKeepsLockUntilRollbackOrDisposal(bool explicitRollback)
    {
        var gate = new Pause();
        var blocker = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
            var result = await access.LockAsync(context, id, ProjectLockPurpose.EditDraft, context.RequestAborted);
            blocker.TrySetResult(((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID);
            await gate.WaitAsync(context.RequestAborted);
            (await database.Projects.SingleAsync()).DocumentJson = Document(id, "rolled back caller edit");
            await database.SaveChangesAsync();
            if (explicitRollback)
            {
                await transaction.RollbackAsync();
            }
            return result;
        });
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        var request = fixture.Client.GetAsync(Path(seeded.ProjectId));
        Task? writer = null;
        JsonElement result = default;
        await using var writerScope = fixture.Database.Services.CreateAsyncScope();
        var database = writerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync();
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            writer = LockProjectAsync(database, seeded.ProjectId);
            await WaitBlockedAsync(fixture, ((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID,
                await blocker.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        }
        finally
        {
            gate.Release.TrySetResult();
            using var drained = await request;
            if (writer is not null)
            {
                await writer.WaitAsync(TimeSpan.FromSeconds(10));
            }
            result = await JsonAsync(drained);
        }
        await Assert.That(result.GetProperty("failure").ValueKind).IsEqualTo(JsonValueKind.Null);
        (await database.ProjectAssignments.SingleAsync()).CanEdit = false;
        await database.SaveChangesAsync();
        await transaction.CommitAsync();
        await AssertStoredAsync(fixture, seeded.ProjectId);
    }

    [Test]
    [Arguments("read")]
    [Arguments("locked")]
    [Arguments("waiting")]
    public async Task ProjectAccess_CancellationDisposesOwnedReadOrCallerTransaction(string stage)
    {
        var whileWaiting = stage == "waiting";
        using var cancellation = new CancellationTokenSource();
        var query = new ProjectQueryPause();
        var waiter = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fixture = await CreateFixtureAsync(async (context, access, database, id) =>
        {
            if (stage == "read")
            {
                await Assert.ThrowsAsync<OperationCanceledException>(() =>
                    access.ReadAsync(context, id, cancellation.Token));
                await Assert.That(database.Database.CurrentTransaction is null).IsTrue();
            }
            else
            {
                await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
                waiter.TrySetResult(((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID);
                await Assert.ThrowsAsync<OperationCanceledException>(() =>
                    access.LockAsync(context, id, ProjectLockPurpose.EditDraft, cancellation.Token));
            }
            return await access.ReadAsync(context, id);
        }, builder => builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(query)));
        var seeded = await SeedAsync(fixture);
        await fixture.SignInAsync(seeded.ActorId);
        await using var holderScope = fixture.Database.Services.CreateAsyncScope();
        var holder = holderScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var held = await holder.Database.BeginTransactionAsync();
        if (whileWaiting)
        {
            await LockProjectAsync(holder, seeded.ProjectId);
        }
        else
        {
            query.Arm();
        }
        var request = fixture.Client.GetAsync(Path(seeded.ProjectId));
        try
        {
            if (whileWaiting)
            {
                await WaitBlockedAsync(fixture, await waiter.Task.WaitAsync(TimeSpan.FromSeconds(10)),
                    ((NpgsqlConnection)holder.Database.GetDbConnection()).ProcessID);
            }
            else
            {
                await query.Pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
            cancellation.Cancel();
            using var response = await request;
            await Assert.That((await JsonAsync(response)).GetProperty("failure").ValueKind).IsEqualTo(JsonValueKind.Null);
        }
        finally
        {
            cancellation.Cancel();
            query.Pause.Release.TrySetResult();
            await held.RollbackAsync();
            if (!request.IsCompleted)
            {
                using var drained = await request;
            }
        }
        await using var observerScope = fixture.Database.Services.CreateAsyncScope();
        var observer = observerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var observerTransaction = await observer.Database.BeginTransactionAsync();
        await LockProjectAsync(observer, seeded.ProjectId).WaitAsync(TimeSpan.FromSeconds(10));
        await observerTransaction.RollbackAsync();
        await AssertStoredAsync(fixture, seeded.ProjectId);
    }

    private static Task LockProjectAsync(ApplicationDbContext database, Guid id) =>
        database.Database.ExecuteSqlInterpolatedAsync($"SELECT id FROM projects WHERE id = {id} FOR UPDATE");

    private static async Task WaitBlockedAsync(HttpsApplicationFixture fixture, int waiter, int blocker)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var connection = (NpgsqlConnection)database.Database.GetDbConnection();
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

    private static async Task AssertStoredAsync(HttpsApplicationFixture fixture, Guid id, bool archived = false)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await database.Projects.AsNoTracking().SingleAsync(project => project.Id == id);
        await Assert.That(project.Revision).IsEqualTo(0L);
        await Assert.That(project.IsArchived).IsEqualTo(archived);
        await Assert.That(project.DocumentJson.Contains(BodyMarker)).IsTrue();
        await Assert.That(project.LastMutationId).IsNull();
    }

    private static Task<HttpsApplicationFixture> CreateFixtureAsync(
        Func<HttpContext, ProjectAccessService, ApplicationDbContext, Guid, Task<ProjectAccessResult>>? operation = null,
        Action<Microsoft.AspNetCore.Builder.WebApplicationBuilder>? configure = null)
        => HttpsApplicationFixture.CreateAsync(configure, app =>
            app.MapGet("/_test/project-access/{id:guid}", async (HttpContext context, Guid id,
                ProjectAccessService access, ApplicationDbContext database) =>
            {
                var result = await (operation is null
                    ? access.ReadAsync(context, id, context.RequestAborted)
                    : operation(context, access, database, id));
                return Results.Json(new { failure = result.Failure?.ToString(), result.Snapshot });
            }).AllowAnonymous());

    private static async Task<(Guid ActorId, Guid ProjectId)> SeedAsync(HttpsApplicationFixture fixture,
        string role = ApplicationRoles.Creator, bool edit = true, bool manage = false, bool publish = false,
        bool inactiveTarget = false)
    {
        var actorId = await fixture.CreateAccountAsync(role);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = role == ApplicationRoles.Administrator
            ? new Organization { Id = Guid.NewGuid(), Name = "Administrative target", IsActive = !inactiveTarget }
            : await database.Organizations.SingleAsync();
        if (role == ApplicationRoles.Administrator)
        {
            database.Organizations.Add(organization);
        }
        var id = Guid.NewGuid();
        database.Projects.Add(new Project
        {
            Id = id,
            OrganizationId = organization.Id,
            SchemaVersion = 1,
            DocumentJson = Document(id, BodyMarker),
            UpdatedAt = fixture.Clock.GetUtcNow(),
        });
        if (role != ApplicationRoles.Administrator)
        {
            database.ProjectAssignments.Add(new ProjectAssignment
            {
                ProjectId = id,
                UserId = actorId,
                CanEdit = edit,
                CanManage = manage,
                CanPublish = publish,
            });
        }
        await database.SaveChangesAsync();
        return (actorId, id);
    }

    private static string Document(Guid id, string title) =>
        $$$"""{"projectId":"{{{id:D}}}","schemaVersion":1,"title":"{{{title}}}","permissions":{"canEdit":true,"canManage":true,"canPublish":true}}""";

    private static string Path(Guid id) => "/_test/project-access/" + id.ToString("D");

    private static async Task<JsonElement> ReadAsync(HttpsApplicationFixture fixture, Guid id)
    {
        using var response = await fixture.Client.GetAsync(Path(id));
        return await JsonAsync(response);
    }

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task AssertDeniedAsync(JsonElement result, ProjectAccessFailure failure)
    {
        await Assert.That(result.GetProperty("failure").GetString()).IsEqualTo(failure.ToString());
        await Assert.That(result.GetProperty("snapshot").ValueKind).IsEqualTo(JsonValueKind.Null);
        await Assert.That(result.GetRawText().Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(result.GetRawText().Contains("revision", StringComparison.OrdinalIgnoreCase)).IsFalse();
    }

    private static DateTimeOffset Cutoff(HttpsApplicationFixture fixture) => new(long.Parse(
        fixture.ReadTicket().Properties.Items[HttpsApplicationFixture.AbsoluteExpiryKey]!,
        System.Globalization.CultureInfo.InvariantCulture), TimeSpan.Zero);

    private static async Task<HttpResponseMessage> DuringPauseAsync(Task<HttpResponseMessage> request,
        Pause pause, Func<Task> action)
    {
        try
        {
            await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await action();
        }
        catch
        {
            pause.Release.TrySetResult();
            using var drained = await request;
            throw;
        }
        finally
        {
            pause.Release.TrySetResult();
        }
        return await request;
    }

    private sealed class Pause
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task WaitAsync(CancellationToken cancellationToken)
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        }
    }

    private sealed class ProjectQueryPause : DbCommandInterceptor
    {
        private int _armed;
        public Pause Pause { get; } = new();
        public void Arm() => Interlocked.Exchange(ref _armed, 1);

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command,
            CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("projects", StringComparison.Ordinal)
                && !command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                await Pause.WaitAsync(cancellationToken);
            }
            return result;
        }
    }
}
