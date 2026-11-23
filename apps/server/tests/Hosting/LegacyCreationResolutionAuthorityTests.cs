using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

public sealed partial class LegacyCreationResolutionTests
{
    [Test]
    [Arguments("project")]
    [Arguments("import")]
    [Arguments("duplicate")]
    [Arguments("class")]
    public async Task BindingIdentityIncludesActorAndCompleteTypedBodyAndForeignIdsCannotBeAdopted(string kind)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var (source, document) = await SourceAsync(fixture, kind);
        var path = Path(kind, source);
        var body = Body(kind, document);

        using (var created = await ResolveAsync(fixture, path, "createAfter=initial", body))
        {
            await SuccessAsync(created, HttpStatusCode.Created, "created");
        }

        var before = await CountsAsync(fixture);
        var changed = Body(kind, document);
        changed[kind == "class" ? "name" : "title"] = "Different typed value";

        using (var unknownBody = await AuthTestRequests.PostAsync(fixture, path, changed))
        {
            await MissingAsync(unknownBody, path);
        }

        if (kind == "class")
        {
            var explicitManagers = Body(kind);
            explicitManagers["managedByUserIds"] = new System.Text.Json.Nodes.JsonArray();
            using var distinctManagers = await AuthTestRequests.PostAsync(fixture, path, explicitManagers);
            await MissingAsync(distinctManagers, path);
        }

        if (kind == "project")
        {
            var environment = Body(kind);
            environment["environmentAssetId"] = "test-room-v1";
            using var distinctEnvironment = await AuthTestRequests.PostAsync(fixture, path, environment);
            await MissingAsync(distinctEnvironment, path);
        }

        if (kind == "duplicate")
        {
            var revised = Body(kind);
            revised["expectedRevision"] = 1;
            using var unknownRevision = await AuthTestRequests.PostAsync(fixture, path, revised);
            await MissingAsync(unknownRevision, path);
        }

        if (kind == "import")
        {
            var changedDocument = Body(kind, document);
            changedDocument["document"]!["title"] = "Different imported title";
            using var unknownDocument = await AuthTestRequests.PostAsync(fixture, path, changedDocument);
            await MissingAsync(unknownDocument, path);
        }

        using var other = fixture.CreateClient();
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator), other);

        using (var foreignActor = await AuthTestRequests.PostAsync(fixture, path, body, other))
        {
            await MissingAsync(foreignActor, path);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);

        using var ownCandidate = await AuthTestRequests.PostAsync(fixture, Path(kind == "class" ? "class" : "project"), new Dictionary<string, object>
        {
            [kind == "class" ? "name" : "title"] = "Same title",
            ["operationId"] = Guid.NewGuid(),
        }, other);

        await Assert.That(ownCandidate.StatusCode).IsEqualTo(HttpStatusCode.Created);

        var foreignId = Id(kind, await ownCandidate.Content.ReadFromJsonAsync<JsonElement>());
        var baseline = await CountsAsync(fixture);
        using var denied = await ResolveAsync(fixture, path, $"useExisting={foreignId:D}", changed);

        await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(baseline);
    }

    [Test]
    public async Task DuplicateBindingIncludesExactSource()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var first = await SeedAsync(fixture);
        var second = await SeedAsync(fixture);
        using var selected = await ResolveAsync(fixture, Path("duplicate", first), $"useExisting={second:D}", Body("duplicate"));
        await SuccessAsync(selected, HttpStatusCode.OK, "existing");
        var before = await CountsAsync(fixture);
        using var unrelated = await AuthTestRequests.PostAsync(fixture, Path("duplicate", second), Body("duplicate"));
        await MissingAsync(unrelated, Path("duplicate", second));

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }

    [Test]
    [Arguments("project", false)]
    [Arguments("import", false)]
    [Arguments("duplicate", false)]
    [Arguments("class", false)]
    [Arguments("project", true)]
    [Arguments("import", true)]
    [Arguments("duplicate", true)]
    [Arguments("class", true)]
    public async Task RevokedOrDeletedTargetsKeepBindingReservedWithoutRecreation(string kind, bool createdBinding)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var (source, document) = await SourceAsync(fixture, kind);
        var candidate = createdBinding ? Guid.Empty : await SeedAsync(fixture, kind == "class" ? "class" : "project");
        var path = Path(kind, source);
        var body = Body(kind, document);
        using var resolved = await ResolveAsync(fixture, path, createdBinding ? "createAfter=initial" : $"useExisting={candidate:D}", body);
        await SuccessAsync(resolved, createdBinding ? HttpStatusCode.Created : HttpStatusCode.OK, createdBinding ? "created" : "existing");
        var id = Id(kind, await resolved.Content.ReadFromJsonAsync<JsonElement>());
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        if (kind == "class")
            await db.ClassroomMembers.Where(row => row.ClassroomId == id).ExecuteDeleteAsync();
        else
            await db.ProjectAssignments.Where(row => row.ProjectId == id).ExecuteDeleteAsync();

        var before = await CountsAsync(fixture);

        using (var revoked = await AuthTestRequests.PostAsync(fixture, path, body))
        {
            await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        using (var replacement = await ResolveAsync(fixture, path, "createAfter=initial", body))
        {
            await Assert.That(replacement.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);

        if (kind == "class")
            await db.Classrooms.Where(row => row.Id == id).ExecuteDeleteAsync();
        else
            await db.Projects.Where(row => row.Id == id).ExecuteDeleteAsync();

        var afterDelete = await CountsAsync(fixture);

        using (var missing = await AuthTestRequests.PostAsync(fixture, path, body))
        {
            await Assert.That(missing.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        using (var cannotRearm = await ResolveAsync(fixture, path, "createAfter=initial", body))
        {
            await Assert.That(cannotRearm.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(afterDelete);
        await Assert.That(afterDelete.Bindings).IsEqualTo(1L);
    }

    [Test]
    [Arguments(false, false)]
    [Arguments(true, false)]
    [Arguments(false, true)]
    [Arguments(true, true)]
    public async Task DuplicateSourceCurrentAccessIsRecheckedForCreatedAndSelectedBindings(bool createdBinding, bool archived)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        await fixture.SignInAsync(await fixture.CreateAccountAsync(ApplicationRoles.Educator));
        var source = await SeedAsync(fixture);
        var target = createdBinding ? Guid.Empty : await SeedAsync(fixture);
        var path = Path("duplicate", source);

        using (var resolved = await ResolveAsync(fixture, path, createdBinding ? "createAfter=initial" : $"useExisting={target:D}", Body("duplicate")))
        {
            await SuccessAsync(resolved, createdBinding ? HttpStatusCode.Created : HttpStatusCode.OK, createdBinding ? "created" : "existing");
        }

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        if (archived)
        {
            await db.Projects.Where(row => row.Id == source).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, true));
        }
        else
        {
            await db.ProjectAssignments.Where(row => row.ProjectId == source).ExecuteDeleteAsync();
        }

        var before = await CountsAsync(fixture);
        using var replay = await AuthTestRequests.PostAsync(fixture, path, Body("duplicate"));

        await Assert.That(replay.StatusCode).IsEqualTo(archived ? HttpStatusCode.Forbidden : HttpStatusCode.NotFound);

        using var decision = await ResolveAsync(fixture, path, "createAfter=initial", Body("duplicate"));

        await Assert.That(decision.StatusCode).IsEqualTo(archived ? HttpStatusCode.Forbidden : HttpStatusCode.NotFound);
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task ClassResolutionRechecksCurrentRoleAfterBindingAndNeverCreatesForCreators(bool createdBinding)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var candidate = createdBinding ? Guid.Empty : await SeedAsync(fixture, "class");

        using (var selected = await ResolveAsync(fixture, Path("class"), createdBinding ? "createAfter=initial" : $"useExisting={candidate:D}", Body("class")))
        {
            await SuccessAsync(selected, createdBinding ? HttpStatusCode.Created : HttpStatusCode.OK, createdBinding ? "created" : "existing");
        }

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await db.OrganizationMemberships.Where(row => row.UserId == actor).Select(row => row.OrganizationId).SingleAsync();
        await db.ClassroomMembers.Where(row => row.UserId == actor).ExecuteDeleteAsync();
        await db.OrganizationMemberships.Where(row => row.UserId == actor).ExecuteDeleteAsync();
        await db.UserRoles.Where(row => row.UserId == actor).ExecuteDeleteAsync();
        db.UserRoles.Add(new IdentityUserRole<Guid> { UserId = actor, RoleId = ApplicationRoles.CreatorId });
        db.OrganizationMemberships.Add(new OrganizationMembership { OrganizationId = organization, UserId = actor, RoleId = ApplicationRoles.CreatorId });
        await db.SaveChangesAsync();
        await fixture.SignInAsync(actor);
        var before = await CountsAsync(fixture);

        using (var replay = await AuthTestRequests.PostAsync(fixture, Path("class"), Body("class")))
        {
            await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        }

        using (var replacement = await ResolveAsync(fixture, Path("class"), "createAfter=initial", Body("class")))
        {
            await Assert.That(replacement.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        }

        var distinct = Body("class");
        distinct["name"] = "Deliberately distinct class";

        using (var fresh = await ResolveAsync(fixture, Path("class"), "createAfter=initial", distinct))
        {
            await Assert.That(fresh.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task MovingActorToAnotherActiveOrganizationCannotReuseOrReplaceEarlierBinding(bool createdBinding)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var candidate = createdBinding ? Guid.Empty : await SeedAsync(fixture);

        using (var selected = await ResolveAsync(fixture, Path("project"), createdBinding ? "createAfter=initial" : $"useExisting={candidate:D}", Body("project")))
        {
            await SuccessAsync(selected, createdBinding ? HttpStatusCode.Created : HttpStatusCode.OK, createdBinding ? "created" : "existing");
        }

        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var destination = new Organization { Id = Guid.NewGuid(), Name = "New active organization" };
        db.Organizations.Add(destination);
        await db.SaveChangesAsync();
        await db.OrganizationMemberships.Where(row => row.UserId == actor).ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, destination.Id));
        await fixture.SignInAsync(actor);
        var before = await CountsAsync(fixture);

        using (var replay = await AuthTestRequests.PostAsync(fixture, Path("project"), Body("project")))
        {
            await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        using (var replacement = await ResolveAsync(fixture, Path("project"), "createAfter=initial", Body("project")))
        {
            await Assert.That(replacement.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task AuthorizedArchivedTargetStaysSelectableButInactiveOrganizationCannotResolveOrCreate(bool archiveAfterSelection)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var target = await SeedAsync(fixture);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        if (archiveAfterSelection)
        {
            using var initial = await ResolveAsync(fixture, Path("project"), $"useExisting={target:D}", Body("project"));
            await SuccessAsync(initial, HttpStatusCode.OK, "existing");
        }

        await db.Projects.Where(row => row.Id == target).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsArchived, true));
        var before = await CountsAsync(fixture);

        using (var archived = await ResolveAsync(fixture, Path("project"), $"useExisting={target:D}", Body("project")))
        {
            await SuccessAsync(archived, HttpStatusCode.OK, "existing");
            var current = await archived.Content.ReadFromJsonAsync<JsonElement>();

            await Assert.That(Id("project", current)).IsEqualTo(target);
            await Assert.That(current.GetProperty("archived").GetBoolean()).IsTrue();
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before with
        {
            Bindings = 1
        });

        using (var replay = await AuthTestRequests.PostAsync(fixture, Path("project"), Body("project")))
        {
            await SuccessAsync(replay, HttpStatusCode.OK, "existing");

            await Assert.That(Id("project", await replay.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(target);
        }

        before = await CountsAsync(fixture);
        var organization = await db.OrganizationMemberships.Where(row => row.UserId == actor).Select(row => row.OrganizationId).SingleAsync();
        await db.Organizations.Where(row => row.Id == organization).ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        using var inactive = await ResolveAsync(fixture, Path("project"), "createAfter=initial", Body("project"));

        await Assert.That(inactive.StatusCode).IsEqualTo(HttpStatusCode.Unauthorized);
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }

    [Test]
    public async Task UpgradeRetainsEqualTitleHistoricalRowsAndResolvesOnlyExplicitUuidWithoutBackfilledReceipt()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await db.GetService<IMigrator>().MigrateAsync("20261114115659_AddAssetRemovalReceipts");
        var organization = await db.OrganizationMemberships.Where(row => row.UserId == actor).Select(row => row.OrganizationId).SingleAsync();
        var projects = new[] { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() };

        foreach (var id in projects)
        {
            db.Projects.Add(new Project { Id = id, OrganizationId = organization, SchemaVersion = 2, DocumentJson = ProjectTestDocuments.Create(id, "Same title", 2), Revision = 7, IsArchived = id == projects[2], UpdatedAt = DateTimeOffset.UtcNow });
            db.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = actor, CanEdit = true, CanManage = true });
        }

        var classes = new[] { Guid.NewGuid(), Guid.NewGuid() };

        foreach (var id in classes)
        {
            db.Classrooms.Add(new Classroom { Id = id, OrganizationId = organization, Name = "Same title" });
            db.ClassroomMembers.Add(new ClassroomMember { ClassroomId = id, OrganizationId = organization, UserId = actor, RoleId = ApplicationRoles.EducatorId });
        }

        await db.SaveChangesAsync();
        await db.Database.MigrateAsync();
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);

        using (var raw = await AuthTestRequests.PostAsync(reopened, Path("project"), Body("project")))
        {
            await MissingAsync(raw, Path("project"));
        }

        var archivedBody = Body("project");
        archivedBody["title"] = "Archived historical intent";

        using (var archived = await ResolveAsync(reopened, Path("project"), $"useExisting={projects[2]:D}", archivedBody))
        {
            await SuccessAsync(archived, HttpStatusCode.OK, "existing");
            var current = await archived.Content.ReadFromJsonAsync<JsonElement>();

            await Assert.That(Id("project", current)).IsEqualTo(projects[2]);
            await Assert.That(current.GetProperty("archived").GetBoolean()).IsTrue();
        }

        using (var selected = await ResolveAsync(reopened, Path("project"), $"useExisting={projects[1]:D}", Body("project")))
        {
            await SuccessAsync(selected, HttpStatusCode.OK, "existing");
            var receipt = await selected.Content.ReadFromJsonAsync<JsonElement>();

            await Assert.That(Id("project", receipt)).IsEqualTo(projects[1]);
            await Assert.That(receipt.GetProperty("revision").GetInt64()).IsEqualTo(7L);
        }

        using (var selectedClass = await ResolveAsync(reopened, Path("class"), $"useExisting={classes[1]:D}", Body("class")))
        {
            await SuccessAsync(selectedClass, HttpStatusCode.OK, "existing");

            await Assert.That(Id("class", await selectedClass.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(classes[1]);
        }

        await Assert.That(await CountsAsync(fixture)).IsEqualTo(new Counts(3, 2, 0, 0, 3));
        await Assert.That(db.Database.HasPendingModelChanges()).IsFalse();

        var failure = await Assert.ThrowsAsync<PostgresException>(() => db.GetService<IMigrator>().MigrateAsync("20261114150108_AddCreationGenerations"));

        await Assert.That(failure!.SqlState).IsEqualTo(PostgresErrorCodes.RaiseException);
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(new Counts(3, 2, 0, 0, 3));
        await Assert.That((await db.Database.GetAppliedMigrationsAsync()).Last()).IsEqualTo("20261114170716_AddLegacyCreationBindings");
    }

    [Test]
    public async Task PersistedV1DigestReplaysKnownHistoricalBindingAfterApplicationRestart()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var actor = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        await fixture.SignInAsync(actor);
        var target = await SeedAsync(fixture);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await db.OrganizationMemberships.Where(row => row.UserId == actor).Select(row => row.OrganizationId).SingleAsync();
        var digest = Convert.FromHexString("6bd4a7697c6034f811f4ddaed2125d3d4f6545fe880127babab7d25e4d8264ec");
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO legacy_creation_bindings (actor_id,intent_digest,kind,purpose,organization_id,resource_id) VALUES ({actor},{digest},'project','project',{organization},{target})");
        var before = await CountsAsync(fixture);
        await fixture.App.StopAsync();
        await using var reopened = await fixture.CreateSiblingAsync(_ => { });
        await reopened.SignInAsync(actor);
        using var response = await AuthTestRequests.PostAsync(reopened, Path("project"), new
        {
            title = "Legacy project"
        });
        await SuccessAsync(response, HttpStatusCode.OK, "existing");

        await Assert.That(Id("project", await response.Content.ReadFromJsonAsync<JsonElement>())).IsEqualTo(target);
        await Assert.That(await CountsAsync(fixture)).IsEqualTo(before);
    }
}
