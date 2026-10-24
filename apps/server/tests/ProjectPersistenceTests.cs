using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectPersistenceTests
{
    private static readonly Guid ProjectId = Guid.Parse("abcdefab-abcd-4abc-8abc-abcdefabcdef");
    private static readonly Guid OrganizationId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid UserId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid MutationId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly DateTimeOffset UpdatedAt = new(2026, 10, 18, 9, 0, 0, TimeSpan.Zero);

    [Test]
    public async Task ProjectDatabase_FreshSchemaMigrations_RoundTripProjectAndAssignments()
    {
        var digest = Enumerable.Range(0, 32).Select(index => (byte)index).ToArray();
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var project = await SeedProjectAsync(database);
            project.IsArchived = true;
            project.Revision = 7;
            project.LastMutationActorId = UserId;
            project.LastMutationId = MutationId;
            project.LastMutationDigest = digest;
            database.ProjectAssignments.Add(new ProjectAssignment
            {
                ProjectId = ProjectId,
                UserId = UserId,
                CanEdit = true,
                CanPublish = true,
            });
            await database.SaveChangesAsync();
            await database.Database.MigrateAsync();
            await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
            await Assert.That(await database.Roles.CountAsync()).IsEqualTo(3);
        }

        await using var reopened = fixture.Services.CreateAsyncScope();
        var persisted = reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await persisted.Projects.SingleAsync();
        await Assert.That(stored.Id).IsEqualTo(ProjectId);
        await Assert.That(stored.OrganizationId).IsEqualTo(OrganizationId);
        await Assert.That(stored.IsArchived).IsTrue();
        await Assert.That(stored.Revision).IsEqualTo(7L);
        await Assert.That(stored.SchemaVersion).IsEqualTo(1);
        await Assert.That(stored.UpdatedAt).IsEqualTo(UpdatedAt);
        await Assert.That(stored.UpdatedAt.Offset).IsEqualTo(TimeSpan.Zero);
        await Assert.That(stored.LastMutationActorId).IsEqualTo((Guid?)UserId);
        await Assert.That(stored.LastMutationId).IsEqualTo((Guid?)MutationId);
        await Assert.That(stored.LastMutationDigest!.SequenceEqual(digest)).IsTrue();
        await AssertDocumentAsync(stored.DocumentJson, CreateDocument(ProjectId));
        var assignment = await persisted.ProjectAssignments.SingleAsync();
        await Assert.That(assignment.ProjectId).IsEqualTo(ProjectId);
        await Assert.That(assignment.UserId).IsEqualTo(UserId);
        await Assert.That(assignment.CanEdit).IsTrue();
        await Assert.That(assignment.CanManage).IsFalse();
        await Assert.That(assignment.CanPublish).IsTrue();
    }

    [Test]
    public async Task ProjectDatabase_UpgradeActualIdentityMigration_PreservesExistingAccountAndMembership()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync("20261014103716_InitialIdentityAndOrganizations");
        string? originalHash;
        string? originalStamp;
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = new ApplicationUser
            {
                Id = UserId,
                UserName = "migration-preserved-creator",
                IsActive = false,
                MustChangePassword = false,
            };
            await Assert.That((await manager.CreateAsync(user, "Synthetic-migration-password1!")).Succeeded).IsTrue();
            await Assert.That((await manager.AddToRoleAsync(user, ApplicationRoles.Creator)).Succeeded).IsTrue();
            originalHash = user.PasswordHash;
            originalStamp = user.SecurityStamp;
            database.Organizations.Add(new Organization { Id = OrganizationId, Name = "Preserved school" });
            database.OrganizationMemberships.Add(new OrganizationMembership
            {
                OrganizationId = OrganizationId,
                UserId = UserId,
                RoleId = ApplicationRoles.CreatorId,
            });
            await database.SaveChangesAsync();
            await database.Database.MigrateAsync();
        }

        await using var reopened = fixture.Services.CreateAsyncScope();
        var persisted = reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var storedUser = await persisted.Users.SingleAsync();
        await Assert.That(storedUser.Id).IsEqualTo(UserId);
        await Assert.That(storedUser.UserName).IsEqualTo("migration-preserved-creator");
        await Assert.That(storedUser.IsActive).IsFalse();
        await Assert.That(storedUser.MustChangePassword).IsFalse();
        await Assert.That(storedUser.PasswordHash).IsEqualTo(originalHash);
        await Assert.That(storedUser.SecurityStamp).IsEqualTo(originalStamp);
        var role = await persisted.UserRoles.SingleAsync();
        await Assert.That(role.UserId).IsEqualTo(UserId);
        await Assert.That(role.RoleId).IsEqualTo(ApplicationRoles.CreatorId);
        var membership = await persisted.OrganizationMemberships.SingleAsync();
        await Assert.That(membership.OrganizationId).IsEqualTo(OrganizationId);
        await Assert.That(membership.UserId).IsEqualTo(UserId);
        await Assert.That(membership.RoleId).IsEqualTo(ApplicationRoles.CreatorId);
        await Assert.That((await persisted.Organizations.SingleAsync()).Name).IsEqualTo("Preserved school");
        await Assert.That(await persisted.Roles.CountAsync()).IsEqualTo(3);
        await Assert.That(await persisted.ProjectAssignments.CountAsync()).IsEqualTo(0);
        persisted.Projects.Add(CreateProject(ProjectId));
        await persisted.SaveChangesAsync();
        await Assert.That(await persisted.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That(await persisted.Database.GetPendingMigrationsAsync()).IsEmpty();
    }

    [Test]
    [Arguments(0L)]
    [Arguments(9007199254740991L)]
    public async Task ProjectDatabase_ExactRevisionBounds_ArePersisted(long revision)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await SeedProjectAsync(database);
        project.Revision = revision;

        await database.SaveChangesAsync();

        await Assert.That((await ReadProjectAsync(fixture)).Revision).IsEqualTo(revision);
    }

    [Test]
    [Arguments(-1L)]
    [Arguments(9007199254740992L)]
    public async Task ProjectDatabase_InvalidRevision_PreservesLastGoodRow(long revision)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        (await SeedProjectAsync(database)).Revision = revision;

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(exception, PostgresErrorCodes.CheckViolation, "CK_projects_revision");
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    public async Task ProjectDatabase_NonpositiveSchemaVersion_PreservesLastGoodRow()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await SeedProjectAsync(database);
        project.SchemaVersion = 0;
        project.DocumentJson = $$"""{"projectId":"{{ProjectId}}","schemaVersion":0}""";

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(exception, PostgresErrorCodes.CheckViolation, "CK_projects_schema_version");
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    [Arguments("[]")]
    [Arguments("null")]
    [Arguments("{}")]
    [Arguments("{\"projectId\":null,\"schemaVersion\":1}")]
    [Arguments("{\"projectId\":1,\"schemaVersion\":1}")]
    [Arguments("{\"projectId\":\"33333333-3333-4333-8333-333333333333\",\"schemaVersion\":1}")]
    [Arguments("{\"projectId\":\"$id\"}")]
    [Arguments("{\"projectId\":\"$id\",\"schemaVersion\":null}")]
    [Arguments("{\"projectId\":\"$id\",\"schemaVersion\":\"1\"}")]
    [Arguments("{\"projectId\":\"$id\",\"schemaVersion\":2}")]
    public async Task ProjectDatabase_InvalidRootOrMetadata_PreservesLastGoodRow(string document)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        (await SeedProjectAsync(database)).DocumentJson = document.Replace("$id", ProjectId.ToString("D"), StringComparison.Ordinal);

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(exception, PostgresErrorCodes.CheckViolation, "CK_projects_document");
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    public async Task ProjectDatabase_EquivalentUppercaseDocumentId_IsAccepted()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await SeedProjectAsync(database);
        var document = CreateDocument(ProjectId).Replace(ProjectId.ToString("D"), ProjectId.ToString("D").ToUpperInvariant(), StringComparison.Ordinal);
        project.DocumentJson = document;

        await database.SaveChangesAsync();

        await AssertDocumentAsync((await ReadProjectAsync(fixture)).DocumentJson, document);
    }

    [Test]
    public async Task ProjectDatabase_SqlNullDocument_IsRejectedWithoutReplacingJson()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        (await SeedProjectAsync(database)).DocumentJson = null!;

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await Assert.That((exception?.InnerException as PostgresException)?.SqlState).IsEqualTo(PostgresErrorCodes.NotNullViolation);
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    [Arguments("infinity")]
    [Arguments("-infinity")]
    public async Task ProjectDatabase_InfiniteTimestamp_PreservesFiniteUpdatedAt(string timestamp)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await SeedProjectAsync(database);

        var exception = await Assert.ThrowsAsync<PostgresException>(async () =>
            await database.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE projects SET updated_at = CAST({timestamp} AS timestamptz) WHERE id = {ProjectId}"));

        await Assert.That(exception?.SqlState).IsEqualTo(PostgresErrorCodes.CheckViolation);
        await Assert.That(exception?.ConstraintName).IsEqualTo("CK_projects_updated_at");
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    [Arguments("missing-actor")]
    [Arguments("missing-id")]
    [Arguments("missing-digest")]
    [Arguments("short-digest")]
    [Arguments("long-digest")]
    public async Task ProjectDatabase_IncompleteOrWrongSizeMutation_PreservesEmptyMetadata(string scenario)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await SeedProjectAsync(database);
        project.LastMutationActorId = scenario == "missing-actor" ? null : UserId;
        project.LastMutationId = scenario == "missing-id" ? null : MutationId;
        project.LastMutationDigest = scenario switch
        {
            "missing-digest" => null,
            "short-digest" => new byte[31],
            "long-digest" => new byte[33],
            _ => new byte[32],
        };

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(exception, PostgresErrorCodes.CheckViolation, "CK_projects_last_mutation");
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    [Arguments("project-organization")]
    [Arguments("assignment-project")]
    [Arguments("assignment-user")]
    [Arguments("mutation-actor")]
    public async Task ProjectDatabase_MissingRelationalTarget_IsRejectedWithoutOrphans(string scenario)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await SeedProjectAsync(database);
        switch (scenario)
        {
            case "project-organization":
                project.OrganizationId = Guid.NewGuid();
                break;
            case "mutation-actor":
                project.LastMutationActorId = Guid.NewGuid();
                project.LastMutationId = MutationId;
                project.LastMutationDigest = new byte[32];
                break;
            default:
                database.ProjectAssignments.Add(new ProjectAssignment
                {
                    ProjectId = scenario == "assignment-project" ? Guid.NewGuid() : ProjectId,
                    UserId = scenario == "assignment-user" ? Guid.NewGuid() : UserId,
                    CanEdit = true,
                });
                break;
        }

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await Assert.That((exception?.InnerException as PostgresException)?.SqlState).IsEqualTo(PostgresErrorCodes.ForeignKeyViolation);
        await AssertProjectUnchangedAsync(fixture);
        await using var reopened = fixture.Services.CreateAsyncScope();
        await Assert.That(await reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectAssignments.CountAsync())
            .IsEqualTo(0);
    }

    [Test]
    public async Task ProjectDatabase_DuplicateAssignment_PreservesOriginalFlags()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await SeedProjectAsync(database);
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = ProjectId, UserId = UserId, CanEdit = true });
            await database.SaveChangesAsync();
        }

        await using (var duplicate = fixture.Services.CreateAsyncScope())
        {
            var database = duplicate.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = ProjectId, UserId = UserId, CanPublish = true });
            var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
            await AssertConstraintAsync(exception, PostgresErrorCodes.UniqueViolation, "PK_project_assignments");
        }

        await using var reopened = fixture.Services.CreateAsyncScope();
        var assignment = await reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectAssignments.SingleAsync();
        await Assert.That(assignment.CanEdit).IsTrue();
        await Assert.That(assignment.CanPublish).IsFalse();
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    [Arguments("organization")]
    [Arguments("assignment-user")]
    [Arguments("mutation-actor")]
    [Arguments("assigned-project")]
    public async Task ProjectDatabase_ReferencedDeletion_IsRestrictedWithoutDataLoss(string scenario)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var project = await SeedProjectAsync(database);
        var hasAssignment = scenario is "assignment-user" or "assigned-project";
        if (hasAssignment)
        {
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = ProjectId, UserId = UserId, CanEdit = true });
        }
        if (scenario == "mutation-actor")
        {
            project.LastMutationActorId = UserId;
            project.LastMutationId = MutationId;
            project.LastMutationDigest = new byte[32];
        }
        await database.SaveChangesAsync();
        FormattableString command = scenario switch
        {
            "organization" => $"DELETE FROM organizations WHERE id = {OrganizationId}",
            "assigned-project" => $"DELETE FROM projects WHERE id = {ProjectId}",
            _ => $"DELETE FROM \"AspNetUsers\" WHERE \"Id\" = {UserId}",
        };

        var exception = await Assert.ThrowsAsync<PostgresException>(async () =>
            await database.Database.ExecuteSqlInterpolatedAsync(command));

        await Assert.That(exception?.SqlState).IsEqualTo(PostgresErrorCodes.RestrictViolation);
        await using var reopened = fixture.Services.CreateAsyncScope();
        var persisted = reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await persisted.Organizations.CountAsync()).IsEqualTo(1);
        await Assert.That(await persisted.Users.CountAsync()).IsEqualTo(1);
        await Assert.That(await persisted.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That(await persisted.ProjectAssignments.CountAsync()).IsEqualTo(hasAssignment ? 1 : 0);
        var stored = await persisted.Projects.SingleAsync();
        await Assert.That(stored.LastMutationActorId).IsEqualTo(scenario == "mutation-actor" ? (Guid?)UserId : null);
        await AssertDocumentAsync(stored.DocumentJson, CreateDocument(ProjectId));
    }

    [Test]
    public async Task ProjectDatabase_AssignmentFailure_RollsBackNewProjectAndPreservesExistingRow()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await SeedProjectAsync(database);
        var newProject = CreateProject(Guid.NewGuid());
        database.Projects.Add(newProject);
        database.ProjectAssignments.Add(new ProjectAssignment
        {
            ProjectId = newProject.Id,
            UserId = Guid.NewGuid(),
            CanEdit = true,
        });

        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await Assert.That((exception?.InnerException as PostgresException)?.SqlState).IsEqualTo(PostgresErrorCodes.ForeignKeyViolation);
        await using var reopened = fixture.Services.CreateAsyncScope();
        var persisted = reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await persisted.Projects.CountAsync()).IsEqualTo(1);
        await Assert.That(await persisted.Projects.AnyAsync(project => project.Id == newProject.Id)).IsFalse();
        await Assert.That(await persisted.ProjectAssignments.CountAsync()).IsEqualTo(0);
        await AssertProjectUnchangedAsync(fixture);
    }

    [Test]
    public async Task ProjectDatabase_RevisionToken_RejectsStaleEfUpdateAndPreservesCommittedDocument()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using (var seed = fixture.Services.CreateAsyncScope())
        {
            await SeedProjectAsync(seed.ServiceProvider.GetRequiredService<ApplicationDbContext>());
        }
        await using var firstScope = fixture.Services.CreateAsyncScope();
        await using var secondScope = fixture.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var second = secondScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var winner = await first.Projects.SingleAsync();
        var stale = await second.Projects.SingleAsync();
        winner.Revision = 1;
        winner.IsArchived = true;
        winner.DocumentJson = $$"""{"projectId":"{{ProjectId}}","schemaVersion":1,"title":"Committed"}""";
        await first.SaveChangesAsync();
        stale.Revision = 1;
        stale.DocumentJson = $$"""{"projectId":"{{ProjectId}}","schemaVersion":1,"title":"Stale"}""";

        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(async () => await second.SaveChangesAsync());

        var stored = await ReadProjectAsync(fixture);
        await Assert.That(stored.Revision).IsEqualTo(1L);
        await Assert.That(stored.IsArchived).IsTrue();
        await Assert.That(stored.UpdatedAt).IsEqualTo(UpdatedAt);
        await AssertDocumentAsync(stored.DocumentJson, winner.DocumentJson);
    }

    private static Project CreateProject(Guid id) => new()
    {
        Id = id,
        OrganizationId = OrganizationId,
        SchemaVersion = 1,
        DocumentJson = CreateDocument(id),
        UpdatedAt = UpdatedAt,
    };

    private static string CreateDocument(Guid id) =>
        $$"""{"projectId":"{{id}}","schemaVersion":1,"scenes":[{"id":"first","x":1.5},{"id":"second","x":-2}]}""";

    private static async Task<Project> SeedProjectAsync(ApplicationDbContext database)
    {
        database.Organizations.Add(new Organization { Id = OrganizationId, Name = "Synthetic project school" });
        database.Users.Add(new ApplicationUser { Id = UserId, UserName = "project-user", NormalizedUserName = "PROJECT-USER" });
        var project = CreateProject(ProjectId);
        database.Projects.Add(project);
        await database.SaveChangesAsync();
        return project;
    }

    private static async Task<Project> ReadProjectAsync(PostgresAccountFixture fixture)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.AsNoTracking().SingleAsync();
    }

    private static async Task AssertProjectUnchangedAsync(PostgresAccountFixture fixture)
    {
        var stored = await ReadProjectAsync(fixture);
        await Assert.That(stored.Id).IsEqualTo(ProjectId);
        await Assert.That(stored.OrganizationId).IsEqualTo(OrganizationId);
        await Assert.That(stored.IsArchived).IsFalse();
        await Assert.That(stored.Revision).IsEqualTo(0L);
        await Assert.That(stored.SchemaVersion).IsEqualTo(1);
        await Assert.That(stored.UpdatedAt).IsEqualTo(UpdatedAt);
        await Assert.That(stored.LastMutationActorId).IsNull();
        await Assert.That(stored.LastMutationId).IsNull();
        await Assert.That(stored.LastMutationDigest).IsNull();
        await AssertDocumentAsync(stored.DocumentJson, CreateDocument(ProjectId));
    }

    private static async Task AssertDocumentAsync(string actual, string expected) =>
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(actual), JsonNode.Parse(expected))).IsTrue();

    private static async Task AssertConstraintAsync(DbUpdateException? exception, string sqlState, string constraint)
    {
        var postgres = exception?.InnerException as PostgresException
            ?? throw new InvalidOperationException("Expected a PostgreSQL constraint failure.");
        await Assert.That(postgres.SqlState).IsEqualTo(sqlState);
        await Assert.That(postgres.ConstraintName).IsEqualTo(constraint);
    }
}
