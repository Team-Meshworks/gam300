using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ProjectDraftStagingTests))]
public sealed class ProjectDraftStagingTests
{
    [Test]
    [Arguments(1)]
    [Arguments(2)]
    public async Task ProjectDraftStaging_ValidatedIndependentCopiesShareTheCallerTransaction(int version)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        var userId = await fixture.CreateAccountAsync();
        await using var documentScope = fixture.App.Services.CreateAsyncScope();
        var documents = documentScope.ServiceProvider.GetRequiredService<ProjectDocumentService>();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organizationId = await database.OrganizationMemberships.Where(row => row.UserId == userId)
            .Select(row => row.OrganizationId).SingleAsync();
        var firstId = Guid.NewGuid();
        var secondId = Guid.NewGuid();
        var source = documents.Read(firstId, ProjectTestDocuments.Create(firstId, "First", version));
        await Assert.That(source.Ok).IsTrue();
        var second = ProjectLifecycleEndpoints.Copy(source.Value!, secondId, "Second");
        var firstGrant = new ProjectAssignment { ProjectId = firstId, UserId = userId, CanEdit = true };
        var secondGrant = new ProjectAssignment { ProjectId = secondId, UserId = userId, CanEdit = true };

        Assert.Throws<InvalidOperationException>(() =>
            ProjectLifecycleEndpoints.StageDraft(database, documents, organizationId, source.Value!, [firstGrant]));
        await using (var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            Assert.Throws<ArgumentException>(() =>
                ProjectLifecycleEndpoints.StageDraft(database, documents, organizationId, source.Value!, [secondGrant]));
            await Assert.That(database.ChangeTracker.Entries<Project>().Any()).IsFalse();
            await Assert.That(ProjectLifecycleEndpoints.StageDraft(database, documents, organizationId, source.Value!, [firstGrant])).IsTrue();
            await Assert.That(ProjectLifecycleEndpoints.StageDraft(database, documents, organizationId, second, [secondGrant])).IsTrue();
            await database.SaveChangesAsync();
            await Assert.That(await database.Projects.CountAsync()).IsEqualTo(2);
            await Assert.That(await database.ProjectAssignments.CountAsync()).IsEqualTo(2);
            await transaction.RollbackAsync();
        }

        await using var verification = fixture.Database.Services.CreateAsyncScope();
        var reopened = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await reopened.Projects.AnyAsync()).IsFalse();
        await Assert.That(await reopened.ProjectAssignments.AnyAsync()).IsFalse();
    }
}
