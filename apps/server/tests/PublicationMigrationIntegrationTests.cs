using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class PublicationMigrationIntegrationTests
{
    [Test]
    public async Task PublicationMigration_CurrentDevUpgradePreservesDraftReceiptsClassAndReviewHistory()
    {
        const string draftMigration = "20261018091152_AddProjectDraftStorage";
        const string publicationMigration = "20261029094707_AddPublicationSnapshots";
        await using var fixture = await PostgresAccountFixture.CreateAsync(draftMigration);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var migrator = database.GetService<IMigrator>();
        var previous = draftMigration;
        foreach (var migration in database.GetService<IMigrationsAssembly>().Migrations.Keys
            .Where(id => string.CompareOrdinal(id, draftMigration) > 0).Order(StringComparer.Ordinal))
        {
            // Reproduce dev before publication storage and its dependent access table were introduced
            if (migration != publicationMigration && !migration.EndsWith("_AddPublicationAccess", StringComparison.Ordinal))
            {
                await PostgresAccountFixture.ExecuteMigrationScriptAsync(database,
                    migrator.GenerateScript(previous, migration, MigrationsSqlGenerationOptions.Idempotent));
            }
            previous = migration;
        }
        await Assert.That((await database.Database.GetAppliedMigrationsAsync()).Contains(publicationMigration)).IsFalse();
        var data = await ReviewPersistenceTests.SeedAsync(fixture);
        var submission = ReviewPersistenceTests.Submission(data);
        database.ReviewSubmissions.Add(submission);
        database.ReviewDecisions.Add(ReviewPersistenceTests.Decision(data));
        var mutation = Guid.NewGuid();
        database.ProjectSaveReceipts.Add(new ProjectSaveReceipt
        {
            ProjectId = data.ProjectId,
            ClientMutationId = mutation,
            ActorId = data.StudentId,
            ExpectedRevision = 6,
            Revision = 7,
            RequestDigest = new byte[32],
            SavedAt = DateTimeOffset.UnixEpoch,
        });
        await database.SaveChangesAsync();
        var before = await database.Projects.AsNoTracking().SingleAsync(row => row.Id == data.ProjectId);

        await database.Database.MigrateAsync();
        var edition = Guid.NewGuid();
        database.Publications.Add(new Publication
        {
            Id = edition,
            ProjectId = data.ProjectId,
            PublishedById = data.EducatorId,
            SourceRevision = 7,
            SchemaVersion = 1,
            DocumentJson = before.DocumentJson,
            AssetReferencesJson = submission.AssetReferencesJson,
            RequestDigest = new byte[32],
        });
        await database.SaveChangesAsync();
        await PostgresAccountFixture.ExecuteMigrationScriptAsync(database,
            migrator.GenerateScript(options: MigrationsSqlGenerationOptions.Idempotent));
        await using var verify = fixture.Services.CreateAsyncScope();
        var reopened = verify.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var draft = await reopened.Projects.SingleAsync(row => row.Id == data.ProjectId);
        await Assert.That(draft.DocumentJson).IsEqualTo(before.DocumentJson);
        await Assert.That(draft.Revision).IsEqualTo(7L);
        await Assert.That((await reopened.ProjectSaveReceipts.SingleAsync()).ClientMutationId).IsEqualTo(mutation);
        await Assert.That((await reopened.ClassAssignmentStudents.SingleAsync()).ProjectId).IsEqualTo(data.ProjectId);
        await Assert.That((await reopened.ReviewSubmissions.SingleAsync()).Id).IsEqualTo(data.SubmissionId);
        await Assert.That((await reopened.ReviewDecisions.SingleAsync()).Id).IsEqualTo(data.DecisionId);
        await Assert.That((await reopened.Publications.SingleAsync()).Id).IsEqualTo(edition);
        await Assert.That(await reopened.Database.GetPendingMigrationsAsync()).IsEmpty();
    }
}
