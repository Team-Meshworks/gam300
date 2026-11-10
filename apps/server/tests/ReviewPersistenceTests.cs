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
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ReviewPersistenceTests))]
public sealed class ReviewPersistenceTests
{
    [Test]
    public async Task ReviewEvidence_UpgradePreservesClassMappingAndStoresPrivateSnapshots()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync("20261029154342_PreserveProjectOrganizationUpdates");
        var data = await SeedAsync(fixture, legacyAssignmentSchema: true);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.GetService<IMigrator>().MigrateAsync();
            database.ReviewSubmissions.Add(Submission(data));
            database.ReviewDecisions.Add(Decision(data));
            await database.SaveChangesAsync();
        }
        await using var reopened = fixture.Services.CreateAsyncScope();
        var verify = reopened.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await verify.Database.GetPendingMigrationsAsync()).IsEmpty();
        await Assert.That(await verify.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == data.ProjectId
            && row.StudentId == data.StudentId)).IsTrue();
        var snapshot = await verify.ReviewSubmissions.AsNoTracking().SingleAsync();
        await Assert.That(snapshot.SourceRevision).IsEqualTo(7L);
        await Assert.That(snapshot.DueAtUnixSeconds).IsEqualTo(2_000_000_000L);
        await Assert.That(snapshot.DocumentJson.Contains("Submitted version", StringComparison.Ordinal)).IsTrue();
        await Assert.That(snapshot.AssetReferencesJson.Contains(new string('a', 64), StringComparison.Ordinal)).IsTrue();
        await Assert.That((await verify.ReviewDecisions.AsNoTracking().SingleAsync()).Feedback).IsEqualTo("Helpful feedback");
    }

    [Test]
    public async Task ReviewEvidence_RollbackCannotDiscardStoredHistory()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var data = await SeedAsync(fixture);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ReviewSubmissions.Add(Submission(data));
            await database.SaveChangesAsync();
        }
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.ThrowsAsync<PostgresException>(async () =>
                await database.GetService<IMigrator>().MigrateAsync("20261029154342_PreserveProjectOrganizationUpdates"));
        }
        await using var verification = fixture.Services.CreateAsyncScope();
        var reopened = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.ReviewSubmissions.CountAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments("submission", "update")]
    [Arguments("submission", "delete")]
    [Arguments("decision", "update")]
    [Arguments("decision", "delete")]
    public async Task ReviewEvidence_DatabaseRejectsChangesToStoredHistory(string table, string operation)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var data = await SeedAsync(fixture);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.ReviewSubmissions.Add(Submission(data));
            database.ReviewDecisions.Add(Decision(data));
            await database.SaveChangesAsync();
        }
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var sql = (table, operation) switch
            {
                ("submission", "update") => "UPDATE review_submissions SET sequence = sequence + 1",
                ("submission", "delete") => "DELETE FROM review_submissions",
                ("decision", "update") => "UPDATE review_decisions SET feedback = 'changed'",
                _ => "DELETE FROM review_decisions",
            };
            var error = await Assert.ThrowsAsync<PostgresException>(async () => await database.Database.ExecuteSqlRawAsync(sql));
            await Assert.That(error?.SqlState).IsEqualTo(PostgresErrorCodes.CheckViolation);
            await Assert.That(error?.ConstraintName).IsEqualTo("CK_review_evidence_immutable");
        }
        await using var verify = fixture.Services.CreateAsyncScope();
        var reopened = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.ReviewSubmissions.CountAsync()).IsEqualTo(1);
        await Assert.That((await reopened.ReviewDecisions.SingleAsync()).Feedback).IsEqualTo("Helpful feedback");
    }

    [Test]
    [Arguments("wrong-student", PostgresErrorCodes.ForeignKeyViolation)]
    [Arguments("wrong-document", PostgresErrorCodes.CheckViolation)]
    [Arguments("invalid-manifest", PostgresErrorCodes.CheckViolation)]
    [Arguments("duplicate-asset", PostgresErrorCodes.CheckViolation)]
    [Arguments("incomplete", PostgresErrorCodes.CheckViolation)]
    [Arguments("due-low", PostgresErrorCodes.CheckViolation)]
    [Arguments("due-high", PostgresErrorCodes.CheckViolation)]
    public async Task ReviewEvidence_RejectsInvalidMappingAndSnapshots(string scenario, string sqlState)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        var data = await SeedAsync(fixture);
        var original = Submission(data);
        var invalid = new ReviewSubmission
        {
            Id = original.Id,
            ProjectId = original.ProjectId,
            StudentId = scenario == "wrong-student" ? data.OtherStudentId : original.StudentId,
            Sequence = original.Sequence,
            SourceRevision = original.SourceRevision,
            DueAtUnixSeconds = scenario switch
            {
                "due-low" => ClassAssignment.MinimumUnixSeconds - 1,
                "due-high" => ClassAssignment.MaximumUnixSeconds + 1,
                _ => original.DueAtUnixSeconds,
            },
            SchemaVersion = original.SchemaVersion,
            CompletionConfirmed = scenario != "incomplete",
            DocumentJson = scenario == "wrong-document" ? ProjectTestDocuments.Create(Guid.NewGuid(), "Other") : original.DocumentJson,
            AssetReferencesJson = scenario switch
            {
                "invalid-manifest" => "[{\"assetId\":\"test-room-v1\",\"sha256\":\"bad\"}]",
                "duplicate-asset" => $"[{{\"assetId\":\"test-room-v1\",\"sha256\":\"{new string('a', 64)}\"}},{{\"assetId\":\"test-room-v1\",\"sha256\":\"{new string('b', 64)}\"}}]",
                _ => original.AssetReferencesJson,
            },
            RequestDigest = original.RequestDigest,
        };
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        database.ReviewSubmissions.Add(invalid);
        var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
        await Assert.That((error?.InnerException as PostgresException)?.SqlState).IsEqualTo(sqlState);
    }

    internal static async Task<Seeded> SeedAsync(PostgresAccountFixture fixture, bool legacyAssignmentSchema = false)
    {
        var data = new Seeded(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(),
            Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        database.Organizations.Add(new Organization { Id = data.OrganizationId, Name = "Review school" });
        foreach (var user in new[] {
            new ApplicationUser { Id = data.EducatorId, UserName = "educator", NormalizedUserName = "EDUCATOR" },
            new ApplicationUser { Id = data.StudentId, UserName = "student", NormalizedUserName = "STUDENT" },
            new ApplicationUser { Id = data.OtherStudentId, UserName = "other", NormalizedUserName = "OTHER" } })
        {
            await LegacyAccountSeed.InsertAsync(database, user);
        }
        foreach (var (id, role) in new[] { (data.EducatorId, ApplicationRoles.EducatorId),
            (data.StudentId, ApplicationRoles.CreatorId), (data.OtherStudentId, ApplicationRoles.CreatorId) })
        {
            database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = id, RoleId = role });
            database.OrganizationMemberships.Add(new OrganizationMembership { OrganizationId = data.OrganizationId, UserId = id, RoleId = role });
            database.ClassroomMembers.Add(new ClassroomMember
            {
                ClassroomId = data.ClassroomId,
                OrganizationId = data.OrganizationId,
                UserId = id,
                RoleId = role
            });
        }
        database.Classrooms.Add(new Classroom { Id = data.ClassroomId, OrganizationId = data.OrganizationId, Name = "Class" });
        if (legacyAssignmentSchema)
        {
            await database.SaveChangesAsync();
            foreach (var project in new[] { Project(data.SourceId, data.OrganizationId, 0), Project(data.ProjectId, data.OrganizationId, 7) })
            {
                await database.Database.ExecuteSqlInterpolatedAsync($"""
                    INSERT INTO projects (id, organization_id, archived, revision, schema_version, document, updated_at)
                    VALUES ({project.Id}, {project.OrganizationId}, {false}, {project.Revision}, {project.SchemaVersion},
                        {project.DocumentJson}::jsonb, {project.UpdatedAt})
                    """);
            }
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO class_assignments (id, classroom_id, organization_id, created_by_user_id,
                    source_project_id, source_revision, due_at_unix_seconds, title, description, instructions, request_digest)
                VALUES ({data.AssignmentId}, {data.ClassroomId}, {data.OrganizationId}, {data.EducatorId},
                    {data.SourceId}, {0L}, {2_000_000_000L}, {"Assignment"}, {"Description"}, {"Instructions"}, {new byte[32]})
                """);
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO class_assignment_students (assignment_id, student_id, classroom_id, organization_id, role_id, project_id)
                VALUES ({data.AssignmentId}, {data.StudentId}, {data.ClassroomId}, {data.OrganizationId}, {ApplicationRoles.CreatorId}, {data.ProjectId})
                """);
            return data;
        }
        database.Projects.AddRange(Project(data.SourceId, data.OrganizationId, 0), Project(data.ProjectId, data.OrganizationId, 7));
        database.ClassAssignments.Add(new ClassAssignment
        {
            Id = data.AssignmentId,
            ClassroomId = data.ClassroomId,
            OrganizationId = data.OrganizationId,
            CreatedByUserId = data.EducatorId,
            SourceProjectId = data.SourceId,
            SourceRevision = 0,
            DueAtUnixSeconds = 2_000_000_000,
            Title = "Assignment",
            Description = "Description",
            Instructions = "Instructions",
            RequestDigest = new byte[32],
        });
        database.ClassAssignmentStudents.Add(new ClassAssignmentStudent
        {
            AssignmentId = data.AssignmentId,
            ClassroomId = data.ClassroomId,
            OrganizationId = data.OrganizationId,
            StudentId = data.StudentId,
            ProjectId = data.ProjectId,
        });
        await database.SaveChangesAsync();
        return data;
    }

    private static Project Project(Guid id, Guid organizationId, long revision) => new()
    {
        Id = id,
        OrganizationId = organizationId,
        Revision = revision,
        SchemaVersion = 1,
        DocumentJson = ProjectTestDocuments.Create(id, "Current draft"),
        UpdatedAt = DateTimeOffset.UtcNow,
    };

    internal static ReviewSubmission Submission(Seeded data) => new()
    {
        Id = data.SubmissionId,
        ProjectId = data.ProjectId,
        StudentId = data.StudentId,
        Sequence = 1,
        SourceRevision = 7,
        DueAtUnixSeconds = 2_000_000_000,
        SchemaVersion = 1,
        CompletionConfirmed = true,
        DocumentJson = ProjectTestDocuments.Create(data.ProjectId, "Submitted version"),
        AssetReferencesJson = $"[{{\"assetId\":\"test-room-v1\",\"sha256\":\"{new string('a', 64)}\"}}]",
        RequestDigest = new byte[32],
    };

    internal static ReviewDecision Decision(Seeded data) => new()
    {
        Id = data.DecisionId,
        SubmissionId = data.SubmissionId,
        EducatorId = data.EducatorId,
        Sequence = 1,
        Outcome = ReviewDecision.Approved,
        Feedback = "Helpful feedback",
        RequestDigest = new byte[32],
    };

    internal sealed record Seeded(Guid OrganizationId, Guid EducatorId, Guid StudentId, Guid OtherStudentId,
        Guid ClassroomId, Guid SourceId, Guid ProjectId, Guid AssignmentId, Guid SubmissionId, Guid DecisionId);
}
