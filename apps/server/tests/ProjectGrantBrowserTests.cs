using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel("Browser")]
public sealed class ProjectGrantBrowserTests
{
    [Test]
    public async Task Educator_AssignsEmptyProjectThroughRealBrowserAndApi()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var outsider = await fixture.CreateAccountAsync();
        var classroom = Guid.NewGuid();
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == educator)
                .Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == student || row.UserId == outsider)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            database.Classrooms.Add(new Classroom { Id = classroom, OrganizationId = organization, Name = "Empty project class" });
            database.ClassroomMembers.AddRange(
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = student, RoleId = ApplicationRoles.CreatorId });
            await database.SaveChangesAsync();
        }
        var files = fixture.WritePemFiles();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "apps", "web", "vite.config.ts"))) { root = root.Parent; }
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root!.FullName, "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/empty-project-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_EDUCATOR"] = await AuthTestRequests.UserNameAsync(fixture, educator);
        start.Environment["SPATIA_TEST_STUDENT"] = await AuthTestRequests.UserNameAsync(fixture, student);
        start.Environment["SPATIA_TEST_OUTSIDER"] = await AuthTestRequests.UserNameAsync(fixture, outsider);
        start.Environment["SPATIA_TEST_CLASS"] = classroom.ToString("D");
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the browser check");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(4)); }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var databaseAfter = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await databaseAfter.AssetCandidates.CountAsync()).IsEqualTo(0);
        var emptyAssignments = await databaseAfter.ClassAssignments.ToArrayAsync();
        await Assert.That(emptyAssignments.Length).IsEqualTo(2);
        var blankAssignment = emptyAssignments.Single(row => row.Title == "Empty source project");
        var copiedAssignment = emptyAssignments.Single(row => row.Title == "Empty class assignment");
        await Assert.That(copiedAssignment.SourceProjectId).IsNotEqualTo(blankAssignment.SourceProjectId);
        var emptyStudents = await databaseAfter.ClassAssignmentStudents.ToArrayAsync();
        await Assert.That(emptyStudents.Length).IsEqualTo(2);
        foreach (var assignment in emptyAssignments)
        {
            var assigned = emptyStudents.Single(row => row.AssignmentId == assignment.Id);
            await Assert.That(assigned.StudentId).IsEqualTo(student);
            await Assert.That(assigned.ProjectId).IsNotEqualTo(assignment.SourceProjectId);
        }
        await Assert.That(emptyStudents[0].ProjectId).IsNotEqualTo(emptyStudents[1].ProjectId);
        await Assert.That(await databaseAfter.Projects.CountAsync()).IsEqualTo(4);
    }

    [Test]
    public async Task EducatorAndStudent_CompleteAssignmentThroughRealBrowserAndApi()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        fixture.App.Configuration["Publication:Origin"] = "https://publications.example.test";
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var student = await fixture.CreateAccountAsync();
        var outsider = await fixture.CreateAccountAsync();
        var classroom = Guid.NewGuid();
        var source = Guid.NewGuid();
        var environment = Guid.NewGuid();
        var retainedProject = Guid.NewGuid();
        var retainedAsset = Guid.NewGuid();
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == educator)
                .Select(row => row.OrganizationId).SingleAsync();
            var bytes = AssetIntakeTests.CreateMinimalGlb();
            database.AssetCandidates.Add(new AssetCandidate
            {
                Id = environment,
                Name = "Approved browser room",
                Kind = "environment",
                Bytes = bytes,
                Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
                Status = "approved",
                Hidden = false,
                ValidationJson = "{}",
                Source = "Synthetic fixture",
                License = "Synthetic test only",
                ReviewNotes = "Fixture approval",
                SubmittedBy = educator,
                ReviewedBy = educator,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            database.AssetCandidates.Add(new AssetCandidate
            {
                Id = retainedAsset,
                Name = "Retired browser room",
                Kind = "environment",
                Bytes = bytes,
                Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
                Status = "approved",
                Hidden = true,
                Deleted = true,
                ValidationJson = "{}",
                Source = "Synthetic fixture",
                License = "Synthetic test only",
                ReviewNotes = "Fixture approval",
                SubmittedBy = educator,
                ReviewedBy = educator,
                CreatedAt = DateTimeOffset.UtcNow,
            });
            database.Projects.Add(new Project
            {
                Id = retainedProject,
                OrganizationId = organization,
                SchemaVersion = 1,
                DocumentJson = ProjectTestDocuments.Create(retainedProject, "Retained room project", 1)
                    .Replace("test-room-v1", retainedAsset.ToString(), StringComparison.Ordinal),
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            database.ProjectAssignments.Add(new ProjectAssignment
            { ProjectId = retainedProject, UserId = educator, CanEdit = true, CanManage = true, CanPublish = true });
            await database.OrganizationMemberships.Where(row => row.UserId == student || row.UserId == outsider)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            database.Classrooms.Add(new Classroom { Id = classroom, OrganizationId = organization, Name = "Live class" });
            database.ClassroomMembers.AddRange(
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = educator, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = student, RoleId = ApplicationRoles.CreatorId },
                new ClassroomMember { ClassroomId = classroom, OrganizationId = organization, UserId = outsider, RoleId = ApplicationRoles.CreatorId });
            database.Projects.Add(new Project
            {
                Id = source,
                OrganizationId = organization,
                SchemaVersion = 1,
                DocumentJson = ProjectTestDocuments.Create(source, "Live source", 1),
                Revision = 0,
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            database.ProjectAssignments.Add(new ProjectAssignment
            { ProjectId = source, UserId = educator, CanEdit = true, CanManage = true, CanPublish = true });
            await database.SaveChangesAsync();
        }
        var files = fixture.WritePemFiles();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "apps", "web", "vite.config.ts")))
        {
            root = root.Parent;
        }
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root!.FullName, "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/assignment-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_EDUCATOR"] = await AuthTestRequests.UserNameAsync(fixture, educator);
        start.Environment["SPATIA_TEST_STUDENT"] = await AuthTestRequests.UserNameAsync(fixture, student);
        start.Environment["SPATIA_TEST_OUTSIDER"] = await AuthTestRequests.UserNameAsync(fixture, outsider);
        start.Environment["SPATIA_TEST_CLASS"] = classroom.ToString("D");
        start.Environment["SPATIA_TEST_SOURCE"] = source.ToString("D");
        start.Environment["SPATIA_TEST_ENVIRONMENT"] = environment.ToString("D");
        start.Environment["SPATIA_TEST_RETAINED_PROJECT"] = retainedProject.ToString("D");
        start.Environment["SPATIA_TEST_RETAINED_ASSET"] = retainedAsset.ToString("D");
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(180)); }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var databaseAfter = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var assignments = await databaseAfter.ClassAssignments.ToArrayAsync();
        await Assert.That(assignments.Length).IsEqualTo(2);
        var blankAssignment = assignments.Single(row => row.Title == "Live blank project");
        var assignment = assignments.Single(row => row.Title == "Live class assignment");
        await Assert.That(assignment.SourceProjectId).IsNotEqualTo(source);
        await Assert.That(blankAssignment.SourceProjectId).IsNotEqualTo(source);
        await Assert.That(assignment.SourceProjectId).IsNotEqualTo(blankAssignment.SourceProjectId);
        await Assert.That(assignment.Description).IsEqualTo("Updated independent exhibit");
        await Assert.That(assignment.Revision).IsEqualTo(2);
        var assignedStudents = await databaseAfter.ClassAssignmentStudents.ToArrayAsync();
        await Assert.That(assignedStudents.Length).IsEqualTo(3);
        var active = assignedStudents.Where(row => row.IsActive).ToArray();
        await Assert.That(active.Length).IsEqualTo(2);
        await Assert.That(active.All(row => row.StudentId == student)).IsTrue();
        var removed = assignedStudents.Single(row => !row.IsActive);
        await Assert.That(removed.StudentId).IsEqualTo(outsider);
        await Assert.That(removed.AssignmentId).IsEqualTo(assignment.Id);
        await Assert.That(active.All(row => row.ProjectId != assignment.SourceProjectId && row.ProjectId != blankAssignment.SourceProjectId)).IsTrue();
        var documents = await databaseAfter.Projects.Select(row => row.DocumentJson).ToArrayAsync();
        await Assert.That(documents.Count(json => System.Text.Json.Nodes.JsonNode.Parse(json)!["title"]!.GetValue<string>()
            == "Live blank project")).IsEqualTo(2);
    }

    [Test]
    public async Task Administrator_CannotEditPublishOrChangeProjectAccessThroughRealBrowserAndApi()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        fixture.App.Configuration["Publication:Origin"] = "https://publications.example.test";
        var administrator = await fixture.CreateAccountAsync(ApplicationRoles.Administrator);
        var creator = await fixture.CreateAccountAsync();
        var educator = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var project = Guid.NewGuid();
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == creator)
                .Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == educator)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            database.Projects.Add(new Project
            {
                Id = project,
                OrganizationId = organization,
                SchemaVersion = 1,
                DocumentJson = ProjectTestDocuments.Create(project, "Grant browser project", 1),
                Revision = 0,
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            database.ProjectAssignments.AddRange(
                new ProjectAssignment { ProjectId = project, UserId = educator, CanEdit = true, CanManage = true, CanPublish = true },
                new ProjectAssignment { ProjectId = project, UserId = creator, CanEdit = true });
            await database.SaveChangesAsync();
        }
        var files = fixture.WritePemFiles();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "apps", "web", "vite.config.ts")))
        {
            root = root.Parent;
        }
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SPATIA_TEST_NODE") ?? "node")
        {
            WorkingDirectory = Path.Combine(root!.FullName, "apps", "web"),
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("tests/project-grants-real-api.check.mjs");
        start.Environment["SPATIA_API_ORIGIN"] = fixture.Address.GetLeftPart(UriPartial.Authority);
        start.Environment["SPATIA_DEV_TLS_CERT"] = files.Certificate;
        start.Environment["SPATIA_DEV_TLS_KEY"] = files.Key;
        start.Environment["SPATIA_API_CA"] = files.Certificate;
        start.Environment["SPATIA_TEST_ADMIN"] = await AuthTestRequests.UserNameAsync(fixture, administrator);
        start.Environment["SPATIA_TEST_CREATOR"] = await AuthTestRequests.UserNameAsync(fixture, creator);
        start.Environment["SPATIA_TEST_PROJECT"] = project.ToString("D");
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90)); }
        catch { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        await Assert.That(process.ExitCode).IsEqualTo(0).Because(await output + await error);
        await using var verify = fixture.App.Services.CreateAsyncScope();
        var result = await verify.ServiceProvider.GetRequiredService<ApplicationDbContext>().ProjectAssignments
            .AsNoTracking().Where(row => row.ProjectId == project).OrderBy(row => row.UserId).ToListAsync();
        await Assert.That(result.Count).IsEqualTo(2);
        await Assert.That(result.Single(row => row.UserId == creator).CanPublish).IsFalse();
        await Assert.That(result.Single(row => row.UserId == educator).CanManage).IsTrue();
        await Assert.That(result.Single(row => row.UserId == educator).CanPublish).IsTrue();
    }
}
