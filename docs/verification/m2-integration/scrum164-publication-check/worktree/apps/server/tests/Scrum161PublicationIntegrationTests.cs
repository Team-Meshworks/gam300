using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class Scrum161PublicationIntegrationTests
{
    [Test]
    public async Task Integration_FreshDatabaseHasBothSchemas()
    {
        await using var fixture = await PostgresAccountFixture.CreateForApplicationAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
        await Assert.That(await database.ClassAssignments.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.ReviewSubmissions.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Integration_PublicationFirstUpgradePreservesExistingEdition()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync("20261029094707_AddPublicationSnapshots");
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organizationId = Guid.NewGuid();
        var actorId = Guid.NewGuid();
        var projectId = Guid.NewGuid();
        var publicationId = Guid.NewGuid();
        var document = ProjectTestDocuments.Create(projectId, "Publication before upgrade");
        database.Organizations.Add(new Organization { Id = organizationId, Name = "Publication school" });
        database.Users.Add(new ApplicationUser { Id = actorId, UserName = "publisher", NormalizedUserName = "PUBLISHER" });
        database.Projects.Add(new Project
        {
            Id = projectId, OrganizationId = organizationId, Revision = 7, SchemaVersion = 1,
            DocumentJson = document, UpdatedAt = DateTimeOffset.UtcNow,
        });
        database.Publications.Add(new Publication
        {
            Id = publicationId, ProjectId = projectId, PublishedById = actorId, SourceRevision = 7,
            SchemaVersion = 1, DocumentJson = document, AssetReferencesJson = "[]", RequestDigest = new byte[32],
        });
        await database.SaveChangesAsync();
        await database.GetService<IMigrator>().MigrateAsync();
        database.ChangeTracker.Clear();
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
        var edition = await database.Publications.AsNoTracking().SingleAsync(row => row.Id == publicationId);
        await Assert.That(edition.ProjectId).IsEqualTo(projectId);
        await Assert.That(edition.SourceRevision).IsEqualTo(7L);
        await Assert.That(edition.DocumentJson.Contains("Publication before upgrade")).IsTrue();
        await Assert.That(await database.ClassAssignments.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Integration_ClassFirstUpgradePreservesExistingMapping()
    {
        var scriptPath = Environment.GetEnvironmentVariable("SPATIA_SCRUM161_MIGRATION_SCRIPT")
            ?? throw new InvalidOperationException("Set the SCRUM-161 migration script path.");
        await using var fixture = await PostgresAccountFixture.CreateFromScriptAsync(await File.ReadAllTextAsync(scriptPath));
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organizationId = Guid.NewGuid();
        var studentId = Guid.NewGuid();
        var projectId = Guid.NewGuid();
        database.Organizations.Add(new Organization { Id = organizationId, Name = "Class school" });
        database.Users.Add(new ApplicationUser { Id = studentId, UserName = "student", NormalizedUserName = "STUDENT" });
        database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = studentId, RoleId = ApplicationRoles.CreatorId });
        database.OrganizationMemberships.Add(new OrganizationMembership
            { UserId = studentId, OrganizationId = organizationId, RoleId = ApplicationRoles.CreatorId });
        database.Projects.Add(new Project
        {
            Id = projectId, OrganizationId = organizationId, Revision = 3, SchemaVersion = 1,
            DocumentJson = ProjectTestDocuments.Create(projectId, "Class before upgrade"), UpdatedAt = DateTimeOffset.UtcNow,
        });
        var assignmentId = AddClassMapping(database, organizationId, studentId, projectId);
        await database.SaveChangesAsync();
        var reviewId = Guid.NewGuid();
        database.ReviewSubmissions.Add(new ReviewSubmission
        {
            Id = reviewId, ProjectId = projectId, StudentId = studentId, Sequence = 1, SourceRevision = 3,
            DueAtUnixSeconds = 2_000_000_000, SchemaVersion = 1, CompletionConfirmed = true,
            DocumentJson = ProjectTestDocuments.Create(projectId, "Review before upgrade"),
            AssetReferencesJson = $"[{{\"assetId\":\"test-room-v1\",\"sha256\":\"{new string('a', 64)}\"}}]",
            RequestDigest = new byte[32],
        });
        await database.SaveChangesAsync();
        await database.GetService<IMigrator>().MigrateAsync();
        database.ChangeTracker.Clear();
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
        await Assert.That((await database.Database.GetAppliedMigrationsAsync()).Contains("20261029094707_AddPublicationSnapshots")).IsTrue();
        await Assert.That(await database.ClassAssignments.AnyAsync(row => row.Id == assignmentId && row.DueAtUnixSeconds == 2_000_000_000)).IsTrue();
        await Assert.That(await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == projectId && row.StudentId == studentId)).IsTrue();
        await Assert.That(await database.ProjectProvenances.AnyAsync(row => row.ProjectId == projectId && row.Kind == ProjectProvenance.Class)).IsTrue();
        await Assert.That((await database.Projects.SingleAsync(row => row.Id == projectId)).Revision).IsEqualTo(3L);
        await Assert.That((await database.ReviewSubmissions.SingleAsync(row => row.Id == reviewId))
            .DocumentJson.Contains("Review before upgrade", StringComparison.Ordinal)).IsTrue();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Integration_KnownClassDraftCannotPublishWithoutApprovalIntegration()
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        await using (var database = fixture.Database())
        {
            AddClassMapping(database, fixture.OrganizationId, fixture.ActorId, fixture.ProjectId);
            await database.SaveChangesAsync();
        }
        var result = await fixture.PublishAsync(new PublicationRequest(Guid.NewGuid(), 0, "{}"), unavailable: true);
        await Assert.That(result.Rejection).IsEqualTo(PublicationRejection.DependencyUnavailable);
        await fixture.AssertCountAsync(0);
        await using (var database = fixture.Database())
        {
            await database.ClassroomMembers.Where(row => row.UserId == fixture.ActorId)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.IsActive, false));
        }
        var denied = await fixture.PublishAsync(new PublicationRequest(Guid.NewGuid(), 0, "{}"), unavailable: true);
        await Assert.That(denied.AccessFailure).IsEqualTo(ProjectAccessFailure.NotFound);
        await fixture.AssertCountAsync(0);
    }

    internal static Guid AddClassMapping(ApplicationDbContext database, Guid organizationId, Guid studentId, Guid projectId)
    {
        var classroomId = Guid.NewGuid();
        var assignmentId = Guid.NewGuid();
        database.Classrooms.Add(new Classroom { Id = classroomId, OrganizationId = organizationId, Name = "Class" });
        database.ClassroomMembers.Add(new ClassroomMember
            { ClassroomId = classroomId, OrganizationId = organizationId, UserId = studentId, RoleId = ApplicationRoles.CreatorId });
        database.ClassAssignments.Add(new ClassAssignment
        {
            Id = assignmentId, ClassroomId = classroomId, OrganizationId = organizationId, CreatedByUserId = studentId,
            SourceProjectId = projectId, SourceRevision = 0, DueAtUnixSeconds = 2_000_000_000,
            Title = "Assignment", Description = "Description", Instructions = "Instructions", RequestDigest = new byte[32],
        });
        database.ClassAssignmentStudents.Add(new ClassAssignmentStudent
        {
            AssignmentId = assignmentId, ClassroomId = classroomId, OrganizationId = organizationId,
            StudentId = studentId, ProjectId = projectId,
        });
        database.ProjectProvenances.Add(new ProjectProvenance
        {
            ProjectId = projectId, OrganizationId = organizationId, Kind = ProjectProvenance.Class,
            ClassAssignmentId = assignmentId, StudentId = studentId,
        });
        return assignmentId;
    }
}
