using System.Net;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;
using Spatia.Server.Reviews;
using Spatia.Server.Security;
using static Spatia.Server.Tests.ReviewSubmissionEndpointTests;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(PublicationReviewTests))]
public sealed class PublicationReviewTests
{
    [Test]
    public async Task PublicationReview_OverrideCannotPublishUnsubmittedClassDraft()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var integration = new FixturePublicationIntegration();
        var request = new PublicationRequest(Guid.NewGuid(), 0, """{"audience":"Authenticated","viewerIds":[],"teacherOverride":true}""");
        var result = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(result.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);
        await Assert.That(result.Acknowledgement).IsNull();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Publications.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task PublicationReview_MissingClassMappingDoesNotProveOrdinaryOrigin()
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        fixture.Integration.OrdinaryOriginVerified = false;
        var result = await fixture.PublishAsync(Request());
        await Assert.That(result.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.DependencyUnavailable);
        await Assert.That(result.Acknowledgement).IsNull();
        await Assert.That(fixture.Integration.Stages).IsEqualTo(0);
        await fixture.AssertCountAsync(0);
    }

    [Test]
    public async Task PublicationReview_RequiresApprovalEvenWhenTheOtherProvidersAreReady()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var integration = new FixturePublicationIntegration();
        var result = await PublishAsync(fixture, data.Educator, data.ProjectId, Request(), integration);
        await Assert.That(result.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);
        await Assert.That(result.Acknowledgement).IsNull();
        await Assert.That(integration.Preparations).IsEqualTo(0);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Publications.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task PublicationReview_EducatorCanPublishApprovedAssignmentAndReplay()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var integration = new FixturePublicationIntegration();
        var submission = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submission, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submission, 0, "approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var request = new PublicationRequest(Guid.NewGuid(), 0, """{"audience":"Authenticated","viewerIds":[],"teacherOverride":true}""");
        var published = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(published.Acknowledgement?.SourceRevision).IsEqualTo((long?)0);
        var replay = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(replay.IsReplay).IsTrue();
        await Assert.That(replay.Acknowledgement).IsEqualTo(published.Acknowledgement);
        var student = await PublishAsync(fixture, data.Student, data.ProjectId,
            new PublicationRequest(Guid.NewGuid(), 0, request.IntentJson), integration);
        await Assert.That(student.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.PolicyDenied);
        await Assert.That(student.Acknowledgement).IsNull();
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var assignment = await database.ClassAssignmentStudents.SingleAsync(row => row.ProjectId == data.ProjectId);
            assignment.IsActive = false;
            await database.SaveChangesAsync();
        }
        var inactiveReplay = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(inactiveReplay.Acknowledgement).IsNull();
    }
    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task PublicationReview_OverrideReplayRequiresCurrentProjectGrants(bool removeManage)
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var integration = new FixturePublicationIntegration();
        var submission = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submission, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submission, 0, "approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var request = new PublicationRequest(Guid.NewGuid(), 0, """{"audience":"Authenticated","viewerIds":[],"teacherOverride":true}""");
        var published = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(published.Acknowledgement?.SourceRevision).IsEqualTo((long?)0);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var grant = await database.ProjectAssignments.SingleAsync(row => row.ProjectId == data.ProjectId && row.UserId == data.Educator);
            if (removeManage) { grant.CanManage = false; }
            else { grant.CanPublish = false; }
            await database.SaveChangesAsync();
        }
        var replay = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(replay.Acknowledgement).IsNull();
        if (removeManage) { await Assert.That(replay.AccessFailure).IsEqualTo((ProjectAccessFailure?)ProjectAccessFailure.NotFound); }
        else { await Assert.That(replay.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.PolicyDenied); }
    }
    [Test]
    public async Task PublicationReview_ApprovedReplayAndNewPublicationRequireCurrentPublishGrant()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var submission = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submission, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submission, 0, "approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var integration = new FixturePublicationIntegration();
        var request = Request();
        var published = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(published.Acknowledgement?.SourceRevision).IsEqualTo((long?)0);
        async Task SetGrant(bool canPublish)
        {
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var grant = await database.ProjectAssignments.SingleAsync(row => row.ProjectId == data.ProjectId && row.UserId == data.Educator);
            grant.CanPublish = canPublish;
            await database.SaveChangesAsync();
        }
        await SetGrant(false);
        var deniedReplay = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        var deniedNew = await PublishAsync(fixture, data.Educator, data.ProjectId, Request(), integration);
        await Assert.That(deniedReplay.Acknowledgement).IsNull();
        await Assert.That(deniedReplay.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.PolicyDenied);
        await Assert.That(deniedNew.Acknowledgement).IsNull();
        await Assert.That(deniedNew.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.PolicyDenied);
        await SetGrant(true);
        var replay = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(replay.IsReplay).IsTrue();
        await Assert.That(replay.Acknowledgement).IsEqualTo(published.Acknowledgement);
        await using var verify = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await verify.ServiceProvider.GetRequiredService<ApplicationDbContext>().Publications.CountAsync()).IsEqualTo(1);
    }
    [Test]
    public async Task PublicationReview_RealDecisionsGateNewEditionsButDoNotRewriteOrReapproveHistoricalRetries()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        var integration = new FixturePublicationIntegration();
        var submission = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submission, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submission, 0, "approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }

        var student = await PublishAsync(fixture, data.Student, data.ProjectId, Request(), integration);
        await Assert.That(student.Acknowledgement?.SourceRevision).IsEqualTo((long?)0);
        var request = Request();
        var published = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(published.Acknowledgement?.SourceRevision).IsEqualTo((long?)0);
        using (var revoked = await DecideAsync(fixture, educator, data.ProjectId, submission, 0, "revoked"))
        { await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var deniedNew = await PublishAsync(fixture, data.Educator, data.ProjectId, Request(), integration);
        await Assert.That(deniedNew.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);
        var deniedStudent = await PublishAsync(fixture, data.Student, data.ProjectId, Request(), integration);
        await Assert.That(deniedStudent.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);

        using (var saved = await SaveAsync(fixture, data.ProjectId))
        { await Assert.That(saved.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        var deniedRevision = await PublishAsync(fixture, data.Educator, data.ProjectId, Request(1), integration);
        await Assert.That(deniedRevision.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);
        var overrideAfterEdit = await PublishAsync(fixture, data.Educator, data.ProjectId,
            new PublicationRequest(Guid.NewGuid(), 1, """{"audience":"Authenticated","viewerIds":[],"teacherOverride":true}"""), integration);
        await Assert.That(overrideAfterEdit.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);
        var replay = await PublishAsync(fixture, data.Educator, data.ProjectId, request, integration);
        await Assert.That(replay.IsReplay).IsTrue();
        await Assert.That(replay.Acknowledgement).IsEqualTo(published.Acknowledgement);

        var latestSubmission = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, latestSubmission, 1, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, latestSubmission, 1, "approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var latest = await PublishAsync(fixture, data.Educator, data.ProjectId, Request(1), integration);
        await Assert.That(latest.Acknowledgement?.SourceRevision).IsEqualTo((long?)1);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var original = await database.Publications.SingleAsync(row => row.Id == request.PublicationId);
        await Assert.That(original.DocumentJson).IsEqualTo((await database.ReviewSubmissions.SingleAsync(row => row.Id == submission)).DocumentJson);
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(3);
        await Assert.That(await database.ReviewDecisions.CountAsync()).IsEqualTo(3);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationReview_RevocationAndPublishingUseTheSameSerializationOrder(bool publishFirst)
    {
        var commit = new PublicationCommitProbe();
        var probe = new ReviewDecisionEndpointTests.ProjectLockProbe();
        await using var fixture = await HttpsApplicationFixture.CreateAsync(builder =>
        {
            builder.Services.AddSingleton<IReviewAssetResolver>(new FixtureAssets());
            builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(commit, probe));
        }, environmentName: "Development");
        var data = await SeedAsync(fixture, false);
        var submission = Guid.NewGuid();
        using (var submitted = await SubmitAsync(fixture, data.ProjectId, submission, 0, true))
        { await Assert.That(submitted.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        using (var approved = await DecideAsync(fixture, educator, data.ProjectId, submission, 0, "approved"))
        { await Assert.That(approved.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        var integration = new FixturePublicationIntegration { OrdinaryOriginVerified = false };
        var entered = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        commit.Before = async (transaction, cancellationToken) =>
        {
            entered.TrySetResult(((NpgsqlConnection)transaction.Connection!).ProcessID);
            await release.Task.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken);
        };
        Task<PublicationResult>? publishing = null;
        Task<HttpResponseMessage>? revoking = null;
        try
        {
            if (publishFirst) { publishing = PublishAsync(fixture, data.Educator, data.ProjectId, Request(), integration); }
            else { revoking = DecideAsync(fixture, educator, data.ProjectId, submission, 0, "revoked"); }
            var blocker = await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            probe.Arm();
            if (publishFirst) { revoking = DecideAsync(fixture, educator, data.ProjectId, submission, 0, "revoked"); }
            else { publishing = PublishAsync(fixture, data.Educator, data.ProjectId, Request(), integration); }
            var waiter = await probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await ReviewDecisionEndpointTests.WaitBlockedAsync(fixture, waiter, blocker);
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.Publications.CountAsync()).IsEqualTo(0);
            release.TrySetResult();
            using var revoked = await revoking!;
            await Assert.That(revoked.StatusCode).IsEqualTo(HttpStatusCode.Created);
            var result = await publishing!;
            if (publishFirst) { await Assert.That(result.Acknowledgement?.SourceRevision).IsEqualTo((long?)0); }
            else { await Assert.That(result.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired); }
            await Assert.That(await database.Publications.CountAsync()).IsEqualTo(publishFirst ? 1 : 0);
            var later = await PublishAsync(fixture, data.Educator, data.ProjectId, Request(), integration);
            await Assert.That(later.Rejection).IsEqualTo((PublicationRejection?)PublicationRejection.ApprovalRequired);
        }
        finally
        {
            release.TrySetResult();
            if (publishing is not null) { await publishing; }
            if (revoking is not null) { (await revoking).Dispose(); }
        }
    }

    internal static PublicationRequest Request(long revision = 0) => new(Guid.NewGuid(), revision, "{}");

    internal static async Task<PublicationResult> PublishAsync(HttpsApplicationFixture fixture, Guid actor, Guid project,
        PublicationRequest request, FixturePublicationIntegration integration)
    {
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stamp = await database.Users.Where(row => row.Id == actor).Select(row => row.SecurityStamp).SingleAsync();
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim(ClaimTypes.NameIdentifier, actor.ToString("D")),
                new Claim("AspNet.Identity.SecurityStamp", stamp!),
            ], "fixture")),
        };
        context.Features.Set(new ValidatedAccountSession(actor, stamp!, fixture.Clock.GetUtcNow().AddHours(1), fixture.Clock));
        var coordinator = new PublicationCoordinator(database, scope.ServiceProvider.GetRequiredService<ProjectAccessService>(),
            scope.ServiceProvider.GetRequiredService<ProjectDocumentService>(), integration);
        return await coordinator.PublishAsync(context, project, request);
    }

    internal static Task<HttpResponseMessage> DecideAsync(HttpsApplicationFixture fixture, HttpClient educator,
        Guid project, Guid submission, long revision, string outcome) => AuthTestRequests.PostAsync(fixture,
        $"/api/v1/projects/{project:D}/submissions/{submission:D}/decisions",
        new { decisionId = Guid.NewGuid(), expectedRevision = revision, outcome, feedback = "Reviewed" }, educator);
}
