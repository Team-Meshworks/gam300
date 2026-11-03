using System.Diagnostics;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class Scrum161UiIntegrationTests
{
    [Test]
    public async Task Integration_RealScreensCreateRetryAndOpenSeparateStudentDrafts()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var teacher = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        var alice = await fixture.CreateAccountAsync();
        var bob = await fixture.CreateAccountAsync();
        var outsider = await fixture.CreateAccountAsync();
        var classId = Guid.NewGuid();
        var sourceId = Guid.NewGuid();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = await database.OrganizationMemberships.Where(row => row.UserId == teacher)
                .Select(row => row.OrganizationId).SingleAsync();
            await database.OrganizationMemberships.Where(row => row.UserId == alice || row.UserId == bob || row.UserId == outsider)
                .ExecuteUpdateAsync(set => set.SetProperty(row => row.OrganizationId, organization));
            database.Classrooms.Add(new Classroom { Id = classId, OrganizationId = organization, Name = "Integration class" });
            database.ClassroomMembers.AddRange(
                new ClassroomMember { ClassroomId = classId, OrganizationId = organization, UserId = teacher, RoleId = ApplicationRoles.EducatorId },
                new ClassroomMember { ClassroomId = classId, OrganizationId = organization, UserId = alice, RoleId = ApplicationRoles.CreatorId },
                new ClassroomMember { ClassroomId = classId, OrganizationId = organization, UserId = bob, RoleId = ApplicationRoles.CreatorId });
            database.Projects.Add(new Project { Id = sourceId, OrganizationId = organization, SchemaVersion = 1,
                DocumentJson = ProjectTestDocuments.Create(sourceId, "Integration source"), UpdatedAt = DateTimeOffset.UtcNow });
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = sourceId, UserId = teacher,
                CanEdit = true, CanManage = true, CanPublish = true });
            await database.SaveChangesAsync();
        }
        var script = Environment.GetEnvironmentVariable("SPATIA_SCRUM161_UI_CHECK")
            ?? throw new InvalidOperationException("Set the UI integration check path.");
        var start = new ProcessStartInfo("node") { RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true };
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment.Remove("ConnectionStrings__Spatia");
        start.ArgumentList.Add(script);
        start.ArgumentList.Add(fixture.Address.ToString());
        start.ArgumentList.Add(JsonSerializer.Serialize(new { teacher, alice, bob, outsider, classId, sourceId,
            aliceName = await AuthTestRequests.UserNameAsync(fixture, alice),
            bobName = await AuthTestRequests.UserNameAsync(fixture, bob) }));
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start UI integration check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90)); }
        catch { process.Kill(true); await process.WaitForExitAsync(); throw; }
        if (process.ExitCode != 0) { throw new InvalidOperationException("UI integration failed: " + await error); }
        await Assert.That((await output).Contains("Real assignment UI integration passed", StringComparison.Ordinal)).IsTrue();
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        var reopened = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.ClassAssignments.CountAsync()).IsEqualTo(1);
        await Assert.That(await reopened.ClassAssignmentStudents.CountAsync()).IsEqualTo(2);
        await Assert.That(await reopened.ProjectProvenances.CountAsync(row => row.Kind == ProjectProvenance.Class)).IsEqualTo(2);
        await Assert.That((await reopened.Projects.SingleAsync(row => row.Id == sourceId)).Revision).IsEqualTo(0L);
    }
}
