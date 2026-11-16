using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class CreationRecoveryBrowserTests
{
    [Test]
    public async Task FreshBrowserRecoversCommittedCreationWithoutASecondProject()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var classroom = Guid.NewGuid();

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await db.OrganizationMemberships.Where(row => row.UserId == educator).Select(row => row.OrganizationId).SingleAsync();
            await db.OrganizationMemberships.Where(row => row.UserId == student).ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            db.Classrooms.Add(new Classroom { Id = classroom, OrganizationId = organization, Name = "Recovery class" });
            db.ClassroomMembers.AddRange(
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = student, RoleId = ApplicationRoles.CreatorId });
            await db.SaveChangesAsync();
        }

        await RunBrowserAsync(fixture, educator, student, classroom, "creation-recovery-real-api.check.mjs");
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        var dbAfter = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        await Assert.That(await dbAfter.Projects.CountAsync()).IsEqualTo(2);

        var assignment = await dbAfter.ClassAssignments.SingleAsync();
        var assigned = await dbAfter.ClassAssignmentStudents.SingleAsync();

        await Assert.That(assigned.StudentId).IsEqualTo(student);
        await Assert.That(assigned.ProjectId).IsNotEqualTo(assignment.SourceProjectId);

        var receipt = await dbAfter.Set<CreationReceipt>().SingleAsync();

        await Assert.That(receipt.ActorId).IsEqualTo(educator);
        await Assert.That(receipt.Purpose).IsEqualTo("assignment-source");
        await Assert.That(receipt.Acknowledged).IsTrue();
        await Assert.That(receipt.ResourceId).IsEqualTo(assignment.SourceProjectId);
    }

    [Test]
    public async Task ExistingProjectsWithoutReceiptsCanBeRecoveredByIdAndAssignedAfterReload()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var classroom = Guid.NewGuid();
        var selected = Guid.NewGuid();
        var otherClass = Guid.NewGuid();
        var sameName = Guid.NewGuid();
        var archived = Guid.NewGuid();
        var hidden = Guid.NewGuid();

        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await db.OrganizationMemberships.Where(row => row.UserId == educator).Select(row => row.OrganizationId).SingleAsync();
            await db.OrganizationMemberships.Where(row => row.UserId == student).ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            db.Classrooms.AddRange(
                new Classroom { Id = classroom, OrganizationId = organization, Name = "Recovered class" },
                new Classroom { Id = otherClass, OrganizationId = organization, Name = "Recovered class" });
            db.ClassroomMembers.AddRange(
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = otherClass, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = student, RoleId = ApplicationRoles.CreatorId });

            foreach (var id in new[] { selected, sameName, archived, hidden })
            {
                db.Projects.Add(new Project
                {
                    Id = id,
                    OrganizationId = organization,
                    SchemaVersion = 1,
                    Revision = id == selected ? 7 : 2,
                    DocumentJson = ProjectTestDocuments.Create(id, "Older gallery"),
                    IsArchived = id == archived,
                    UpdatedAt = DateTimeOffset.UnixEpoch.AddDays(1),
                });
                db.ProjectProvenances.Add(new ProjectProvenance { ProjectId = id, OrganizationId = organization, Kind = ProjectProvenance.Ordinary });

                if (id != hidden)
                {
                    db.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = educator, CanManage = true, CanEdit = true, CanPublish = true });
                }
            }

            await db.SaveChangesAsync();

            await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
        }

        await RunBrowserAsync(fixture, educator, student, classroom, "historical-creation-real-api.check.mjs",
            ("SPATIA_TEST_PROJECT", selected.ToString("D")), ("SPATIA_TEST_SAME_NAME", sameName.ToString("D")),
            ("SPATIA_TEST_ARCHIVED", archived.ToString("D")), ("SPATIA_TEST_HIDDEN", hidden.ToString("D")),
            ("SPATIA_TEST_OTHER_CLASS", otherClass.ToString("D")));

        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var database = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var assignment = await database.ClassAssignments.SingleAsync();

        await Assert.That(assignment.ClassroomId).IsEqualTo(classroom);
        await Assert.That(assignment.SourceProjectId).IsEqualTo(selected);
        await Assert.That(assignment.SourceRevision).IsEqualTo(7L);

        var assigned = await database.ClassAssignmentStudents.SingleAsync();

        await Assert.That(assigned.StudentId).IsEqualTo(student);
        await Assert.That(assigned.ProjectId).IsNotEqualTo(selected);
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(5);
        await Assert.That(await database.Classrooms.CountAsync()).IsEqualTo(2);
        await Assert.That(await database.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
    }

    private static async Task RunBrowserAsync(HttpsApplicationFixture fixture, Guid educator, Guid student, Guid classroom,
        string script, params (string Name, string Value)[] environment)
    {
        var files = fixture.WritePemFiles();
        var root = new DirectoryInfo(AppContext.BaseDirectory);

        while (root is not null && !File.Exists(Path.Combine(root.FullName, "apps", "web", "vite.config.ts")))
            root = root.Parent;

        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root!.FullName, "apps", "web"),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/" + script);
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_EDUCATOR"] = await AuthTestRequests.UserNameAsync(fixture, educator);
        start.Environment["SPATIA_TEST_STUDENT"] = await AuthTestRequests.UserNameAsync(fixture, student);
        start.Environment["SPATIA_TEST_CLASS"] = classroom.ToString("D");

        foreach (var (name, value) in environment)
        {
            start.Environment[name] = value;
        }

        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the creation recovery browser check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();

        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(4));
        }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }

        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
    }
}
