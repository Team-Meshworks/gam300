using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Spatia.ProjectFormat;
using Spatia.Server.Accounts;
using Spatia.Server.Classes;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ReviewPublicationIntegrationTests
{
    [Test]
    public async Task Publisher_UsesCurrentReviewAndRetainsHistoricalEdition()
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var unverified = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 0, "{}"));
        await Assert.That(unverified.Rejection).IsEqualTo(PublicationRejection.DependencyUnavailable);
        var educator = Guid.NewGuid();
        await using (var database = fixture.Database())
        {
            var assignment = Scrum161PublicationIntegrationTests.AddClassMapping(database, fixture.OrganizationId, fixture.ActorId, fixture.ProjectId);
            database.Users.Add(new ApplicationUser { Id = educator, UserName = "reviewer", NormalizedUserName = "REVIEWER", SecurityStamp = "fixture" });
            database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = educator, RoleId = ApplicationRoles.EducatorId });
            database.OrganizationMemberships.Add(new OrganizationMembership
                { UserId = educator, OrganizationId = fixture.OrganizationId, RoleId = ApplicationRoles.EducatorId });
            await database.SaveChangesAsync();
            var classroom = await database.ClassAssignments.Where(row => row.Id == assignment).Select(row => row.ClassroomId).SingleAsync();
            database.ClassroomMembers.Add(new ClassroomMember
                { ClassroomId = classroom, OrganizationId = fixture.OrganizationId, UserId = educator, RoleId = ApplicationRoles.EducatorId });
            database.ProjectAssignments.Add(new ProjectAssignment
                { ProjectId = fixture.ProjectId, UserId = educator, CanEdit = true, CanManage = true, CanPublish = true });
            await database.SaveChangesAsync();
        }
        var waiting = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 0, "{}"));
        await Assert.That(waiting.Rejection).IsEqualTo(PublicationRejection.ApprovalRequired);
        var first = await AddSubmissionAsync(fixture, sequence: 1, revision: 0);
        var pending = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 0, "{}"));
        await Assert.That(pending.Rejection).IsEqualTo(PublicationRejection.ApprovalRequired);
        await AddDecisionAsync(fixture, educator, first, 1, ReviewDecision.Approved);
        var originalRequest = new PublicationRequest(Guid.NewGuid(), 0, "{}");
        var original = await PublishAsync(fixture, originalRequest);
        await Assert.That(original.Acknowledgement is not null).IsTrue();
        var originalEdition = await fixture.ReadAsync(originalRequest.PublicationId);
        await using (var database = fixture.Database())
        {
            await database.Projects.Where(row => row.Id == fixture.ProjectId)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.Revision, 1));
        }
        var stale = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 1, "{}"));
        await Assert.That(stale.Rejection).IsEqualTo(PublicationRejection.ApprovalRequired);
        var replay = await PublishAsync(fixture, originalRequest);
        await Assert.That(replay.IsReplay).IsTrue();
        await Assert.That(replay.Acknowledgement).IsEqualTo(original.Acknowledgement);
        var second = await AddSubmissionAsync(fixture, sequence: 2, revision: 1);
        await AddDecisionAsync(fixture, educator, second, 1, ReviewDecision.Returned);
        var returned = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 1, "{}"));
        await Assert.That(returned.Rejection).IsEqualTo(PublicationRejection.ApprovalRequired);
        var third = await AddSubmissionAsync(fixture, sequence: 3, revision: 1);
        await AddDecisionAsync(fixture, educator, third, 1, ReviewDecision.Approved);
        var approved = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 1, "{}"));
        await Assert.That(approved.Acknowledgement is not null).IsTrue();
        await AddDecisionAsync(fixture, educator, third, 2, ReviewDecision.Revoked);
        var revoked = await PublishAsync(fixture, new PublicationRequest(Guid.NewGuid(), 1, "{}"));
        await Assert.That(revoked.Rejection).IsEqualTo(PublicationRejection.ApprovalRequired);
        await Assert.That((await fixture.ReadAsync(originalRequest.PublicationId)).DocumentJson).IsEqualTo(originalEdition.DocumentJson);
        await fixture.AssertCountAsync(2);
    }

    private static async Task<Guid> AddSubmissionAsync(PublicationCoordinatorFixture fixture, long sequence, long revision)
    {
        await using var database = fixture.Database();
        var document = await database.Projects.Where(row => row.Id == fixture.ProjectId).Select(row => row.DocumentJson).SingleAsync();
        var id = Guid.NewGuid();
        database.ReviewSubmissions.Add(new ReviewSubmission
        {
            Id = id, ProjectId = fixture.ProjectId, StudentId = fixture.ActorId, Sequence = sequence,
            SourceRevision = revision, DueAtUnixSeconds = 2_000_000_000, SchemaVersion = 1,
            CompletionConfirmed = true, DocumentJson = document, RequestDigest = new byte[32],
            AssetReferencesJson = $"[{{\"assetId\":\"test-room-v1\",\"sha256\":\"{new string('a', 64)}\"}},{{\"assetId\":\"test-crate-v1\",\"sha256\":\"{new string('a', 64)}\"}}]",
        });
        await database.SaveChangesAsync();
        return id;
    }

    private static async Task AddDecisionAsync(PublicationCoordinatorFixture fixture, Guid educator, Guid submission,
        long sequence, string outcome)
    {
        await using var database = fixture.Database();
        database.ReviewDecisions.Add(new ReviewDecision
        {
            Id = Guid.NewGuid(), SubmissionId = submission, EducatorId = educator, Sequence = sequence,
            Outcome = outcome, Feedback = "fixture", RequestDigest = new byte[32],
        });
        await database.SaveChangesAsync();
    }

    private static async Task<PublicationResult> PublishAsync(PublicationCoordinatorFixture fixture, PublicationRequest request)
    {
        await using var database = fixture.Database();
        var coordinator = new PublicationCoordinator(database, fixture.Access(database), fixture.Documents,
            new FixtureReviewIntegration(fixture.Integration));
        return await coordinator.PublishAsync(fixture.Context(), fixture.ProjectId, request);
    }

    // Test-only owner adapter: real asset and audience policy must still be supplied before publication is enabled.
    private sealed class FixtureReviewIntegration(FixturePublicationIntegration next) : IPublicationIntegration
    {
        public async Task<PublicationPreparation> PrepareAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
            PublicationRequest request, IAuthoredProject document, CancellationToken cancellationToken)
        {
            var state = await ReviewApproval.CheckLockedAsync(database, project, cancellationToken);
            return state switch
            {
                ReviewApprovalState.Approved => await next.PrepareAsync(database, project, request, document, cancellationToken),
                ReviewApprovalState.ApprovalRequired => PublicationPreparation.Denied(PublicationRejection.ApprovalRequired),
                _ => PublicationPreparation.Denied(PublicationRejection.DependencyUnavailable),
            };
        }
        public Task<PublicationRejection?> AuthorizeReplayAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
            PublicationRequest request, Publication edition, CancellationToken cancellationToken) =>
            next.AuthorizeReplayAsync(database, project, request, edition, cancellationToken);
        public Task<PublicationRejection?> StageAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
            PublicationRequest request, Publication edition, CancellationToken cancellationToken) =>
            next.StageAsync(database, project, request, edition, cancellationToken);
    }
}
