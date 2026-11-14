using System.Text.Json;
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

[NotInParallel(nameof(ClassAssignmentPersistenceTests))]
public sealed class ClassAssignmentPersistenceTests
{
    [Test]
    public async Task AssignmentEditing_DowngradeCannotRestoreRemovedStudentAccess()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await database.ClassAssignments.Where(row => row.Id == data.AssignmentId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Revision, 1));
        await database.ClassAssignmentStudents.Where(row => row.AssignmentId == data.AssignmentId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        var migrator = database.GetService<IMigrator>();
        await Assert.ThrowsAsync<PostgresException>(() => migrator.MigrateAsync("20261107185607_AddProgressReviews"));
        await Assert.That((await database.ClassAssignmentStudents.SingleAsync(row => row.AssignmentId == data.AssignmentId)).IsActive).IsFalse();
    }

    [Test]
    public async Task ClassAssignmentDatabase_MetadataAndClassOriginPersistOutsideProjectJson()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var assignment = await database.ClassAssignments.AsNoTracking().SingleAsync();
        await Assert.That(assignment.DueAtUnixSeconds).IsEqualTo(2_000_000_000L);
        await Assert.That(DateTimeOffset.FromUnixTimeSeconds(assignment.DueAtUnixSeconds).ToUnixTimeSeconds()).IsEqualTo(2_000_000_000L);
        await Assert.That(assignment.Title).IsEqualTo("Assignment");
        await Assert.That(assignment.Description).IsEqualTo("Description");
        await Assert.That(assignment.Instructions).IsEqualTo("Instructions");
        var origin = await database.ProjectProvenances.AsNoTracking().SingleAsync();
        await Assert.That(origin.Kind).IsEqualTo(ProjectProvenance.Class);
        await Assert.That(origin.ClassAssignmentId).IsEqualTo((Guid?)data.AssignmentId);
        await Assert.That(origin.StudentId).IsEqualTo((Guid?)data.StudentId);
        await Assert.That(await database.ProjectProvenances.AnyAsync(row => row.ProjectId == data.SourceId)).IsFalse();
        var project = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == data.ProjectId);
        using var json = JsonDocument.Parse(project.DocumentJson);
        await Assert.That(json.RootElement.TryGetProperty("dueAtUnixSeconds", out _)).IsFalse();
        await Assert.That(json.RootElement.TryGetProperty("instructions", out _)).IsFalse();
        await Assert.That(json.RootElement.TryGetProperty("classAssignmentId", out _)).IsFalse();
    }

    [Test]
    public async Task ClassAssignmentDatabase_UnixDeadlineBoundsAreEnforced()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        foreach (var (seconds, valid) in new[]
        {
            (ClassAssignment.MinimumUnixSeconds - 1, false), (ClassAssignment.MinimumUnixSeconds, true),
            (ClassAssignment.MaximumUnixSeconds, true), (ClassAssignment.MaximumUnixSeconds + 1, false),
        })
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ClassAssignments.Add(NewAssignment(data, seconds));
            if (valid) { await database.SaveChangesAsync(); }
            else
            {
                var failure = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
                await Assert.That((failure?.InnerException as PostgresException)?.SqlState).IsEqualTo(PostgresErrorCodes.CheckViolation);
            }
        }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var saved = await verification.ServiceProvider.GetRequiredService<ApplicationDbContext>().ClassAssignments
            .Select(row => row.DueAtUnixSeconds).ToListAsync();
        await Assert.That(saved.Contains(ClassAssignment.MinimumUnixSeconds) && saved.Contains(ClassAssignment.MaximumUnixSeconds)).IsTrue();
        await Assert.That(saved.Count).IsEqualTo(3);
    }

    [Test]
    [Arguments("foreign-project", PostgresErrorCodes.ForeignKeyViolation)]
    [Arguments("educator", PostgresErrorCodes.ForeignKeyViolation)]
    [Arguments("duplicate-student", PostgresErrorCodes.UniqueViolation)]
    [Arguments("partial-origin", PostgresErrorCodes.CheckViolation)]
    [Arguments("foreign-origin", PostgresErrorCodes.ForeignKeyViolation)]
    public async Task ClassAssignmentDatabase_RejectsInvalidStudentAndOriginMappings(string scenario, string expectedCode)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            if (scenario is "partial-origin" or "foreign-origin")
            {
                database.ProjectProvenances.Add(new ProjectProvenance
                {
                    ProjectId = scenario == "foreign-origin" ? data.ForeignProjectId : data.SourceId,
                    OrganizationId = scenario == "foreign-origin" ? data.ForeignOrganizationId : data.OrganizationId,
                    Kind = ProjectProvenance.Class,
                    ClassAssignmentId = data.AssignmentId,
                    StudentId = scenario == "foreign-origin" ? data.StudentId : null,
                });
            }
            else
            {
                database.ClassAssignmentStudents.Add(new ClassAssignmentStudent
                {
                    AssignmentId = data.AssignmentId,
                    ClassroomId = data.ClassroomId,
                    OrganizationId = data.OrganizationId,
                    StudentId = scenario == "educator" ? data.EducatorId : scenario == "foreign-project" ? data.OtherStudentId : data.StudentId,
                    ProjectId = scenario == "foreign-project" ? data.ForeignProjectId : data.SourceId,
                });
            }
            var failure = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
            await Assert.That((failure?.InnerException as PostgresException)?.SqlState).IsEqualTo(expectedCode);
        }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var reopened = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.ClassAssignmentStudents.CountAsync()).IsEqualTo(1);
        await Assert.That(await reopened.ProjectProvenances.CountAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments("source")]
    [Arguments("student")]
    public async Task ClassAssignmentDatabase_RejectsMovingReferencedProjectsToAnotherOrganization(string scenario)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        var projectId = scenario == "source" ? data.SourceId : data.ProjectId;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var project = await database.Projects.SingleAsync(row => row.Id == projectId);
            project.OrganizationId = data.ForeignOrganizationId;
            var failure = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
            await Assert.That((failure?.InnerException as PostgresException)?.SqlState).IsEqualTo(PostgresErrorCodes.ForeignKeyViolation);
        }
        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var reopened = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await reopened.Projects.SingleAsync(row => row.Id == projectId)).OrganizationId).IsEqualTo(data.OrganizationId);
    }

    [Test]
    public async Task ClassAssignmentDatabase_OrganizationConstraintMigrationRoundTripsExistingData()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var data = await SeedAsync(fixture);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var migrator = database.GetService<IMigrator>();
        await migrator.MigrateAsync("20261029150457_AddClassAssignmentStorage");
        await migrator.MigrateAsync();
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
        await Assert.That(await database.ClassAssignments.AnyAsync(row => row.Id == data.AssignmentId)).IsTrue();
        await Assert.That(await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == data.ProjectId)).IsTrue();
        await Assert.That(await database.ProjectProvenances.AnyAsync(row => row.ProjectId == data.ProjectId)).IsTrue();
    }

    private static async Task<Seeded> SeedAsync(HttpsApplicationFixture fixture)
    {
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var otherStudent = await fixture.CreateAccountAsync();
        var foreign = await fixture.CreateAccountAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = await database.OrganizationMemberships.Where(row => row.UserId == educator)
            .Select(row => row.OrganizationId).SingleAsync();
        var foreignOrganization = await database.OrganizationMemberships.Where(row => row.UserId == foreign)
            .Select(row => row.OrganizationId).SingleAsync();
        await database.OrganizationMemberships.Where(row => row.UserId == student || row.UserId == otherStudent)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
        var data = new Seeded(Guid.NewGuid(), organization, foreignOrganization, educator, student, otherStudent,
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        database.Classrooms.Add(new Classroom { Id = data.ClassroomId, OrganizationId = organization, Name = "Class" });
        database.ClassroomMembers.AddRange(
            new ClassroomMember { ClassroomId = data.ClassroomId, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
            new ClassroomMember { ClassroomId = data.ClassroomId, OrganizationId = organization, UserId = student, RoleId = ApplicationRoles.CreatorId },
            new ClassroomMember { ClassroomId = data.ClassroomId, OrganizationId = organization, UserId = otherStudent, RoleId = ApplicationRoles.CreatorId });
        database.Projects.AddRange(NewProject(data.SourceId, organization), NewProject(data.ProjectId, organization), NewProject(data.ForeignProjectId, foreignOrganization));
        var assignment = NewAssignment(data, 2_000_000_000);
        assignment.Id = data.AssignmentId;
        database.ClassAssignments.Add(assignment);
        database.ClassAssignmentStudents.Add(new ClassAssignmentStudent
        {
            AssignmentId = data.AssignmentId,
            ClassroomId = data.ClassroomId,
            OrganizationId = organization,
            StudentId = student,
            ProjectId = data.ProjectId,
        });
        database.ProjectProvenances.Add(new ProjectProvenance
        {
            ProjectId = data.ProjectId,
            OrganizationId = organization,
            Kind = ProjectProvenance.Class,
            ClassAssignmentId = data.AssignmentId,
            StudentId = student,
        });
        await database.SaveChangesAsync();
        return data;
    }

    private static ClassAssignment NewAssignment(Seeded data, long due) => new()
    {
        Id = Guid.NewGuid(),
        ClassroomId = data.ClassroomId,
        OrganizationId = data.OrganizationId,
        CreatedByUserId = data.EducatorId,
        SourceProjectId = data.SourceId,
        SourceRevision = 0,
        DueAtUnixSeconds = due,
        Title = "Assignment",
        Description = "Description",
        Instructions = "Instructions",
        RequestDigest = new byte[32],
    };

    private static Project NewProject(Guid id, Guid organizationId) => new()
    {
        Id = id,
        OrganizationId = organizationId,
        SchemaVersion = 1,
        DocumentJson = ProjectTestDocuments.Create(id, "Stored project"),
        UpdatedAt = DateTimeOffset.UtcNow,
    };

    private sealed record Seeded(Guid ClassroomId, Guid OrganizationId, Guid ForeignOrganizationId, Guid EducatorId,
        Guid StudentId, Guid OtherStudentId, Guid AssignmentId, Guid SourceId, Guid ProjectId, Guid ForeignProjectId);
}
