using System.Data;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed partial class PublicationCoordinatorTests
{
    private const string Intent = "{\"fixtureAudience\":\"private-test-only\",\"contract\":1}";
    private static PublicationRequest Request(long revision = 0, Guid? id = null, string intent = Intent) =>
        new(id ?? Guid.NewGuid(), revision, intent);

    [Test]
    [Arguments(1, 0L)]
    [Arguments(2, 7L)]
    [Arguments(1, Project.MaxRevision)]
    public async Task PublicationCoordinator_CapturesExactSavedContentAndReplaysAfterLaterDrafts(int version, long revision)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync(version, revision: revision);
        var request = Request(revision);
        var result = await fixture.PublishAsync(request);
        await AssertCommittedAsync(result, request, fixture.ProjectId, replay: false);
        var original = await fixture.ReadAsync(request.PublicationId);
        await Assert.That(original.CreatedAt).IsEqualTo(result.Acknowledgement!.CreatedAt);
        await Assert.That(original.SchemaVersion).IsEqualTo(version);
        await Assert.That(original.RequestDigest.SequenceEqual(request.Digest(fixture.ProjectId, fixture.ActorId))).IsTrue();
        await Assert.That(original.PublishedById).IsEqualTo(fixture.ActorId);
        await using (var database = fixture.Database())
        {
            var project = await database.Projects.SingleAsync();
            await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(project.DocumentJson), JsonNode.Parse(original.DocumentJson))).IsTrue();
            await Assert.That(project.Revision).IsEqualTo(revision);
            await Assert.That(project.UpdatedAt).IsEqualTo(DateTimeOffset.UnixEpoch);
            project.DocumentJson = ProjectTestDocuments.Create(fixture.ProjectId, "Newer metadata and content", version);
            project.Revision = revision == Project.MaxRevision ? revision : revision + 1;
            await database.SaveChangesAsync();
            await fixture.PublishAsync(Request(project.Revision));
        }
        // Neither later approval denial nor the current draft's format participates in historical retry.
        fixture.Integration.PreparationFailure = PublicationRejection.ApprovalRequired;
        await using (var database = fixture.Database())
        {
            await database.Database.ExecuteSqlRawAsync("UPDATE projects SET document = document - 'scenes'");
        }
        var retry = await fixture.PublishAsync(request);
        await AssertCommittedAsync(retry, request, fixture.ProjectId, replay: true);
        await Assert.That(retry.Acknowledgement).IsEqualTo(result.Acknowledgement);
        await Assert.That((await fixture.ReadAsync(request.PublicationId)).DocumentJson).IsEqualTo(original.DocumentJson);
        await Assert.That(fixture.Integration.Preparations).IsEqualTo(2);
        await Assert.That(fixture.Integration.Stages).IsEqualTo(2);
        await fixture.AssertCountAsync(2);
    }

    [Test]
    [Arguments(ApplicationRoles.Creator)]
    [Arguments(ApplicationRoles.Educator)]
    [Arguments(ApplicationRoles.Administrator)]
    public async Task PublicationCoordinator_UsesExistingRoleAndCanPublishRules(string role)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync(role: role);
        var request = Request();
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, false);
    }

    [Test]
    [Arguments("unassigned", ProjectAccessFailure.NotFound)]
    [Arguments("no-publish", ProjectAccessFailure.OperationForbidden)]
    [Arguments("publish-only", ProjectAccessFailure.NotFound)]
    [Arguments("archived", ProjectAccessFailure.ProjectReadOnly)]
    [Arguments("anonymous", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("missing-session", ProjectAccessFailure.AuthenticationRequired)]
    [Arguments("forged-stamp", ProjectAccessFailure.AuthenticationRequired)]
    public async Task PublicationCoordinator_DeniesUnauthorizedCreationAndExactRetry(string change, ProjectAccessFailure failure)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var existing = Request();
        await fixture.PublishAsync(existing);
        var context = fixture.Context();
        await using (var database = fixture.Database())
        {
            switch (change)
            {
                case "unassigned": database.ProjectAssignments.Remove(await database.ProjectAssignments.SingleAsync()); break;
                case "no-publish": (await database.ProjectAssignments.SingleAsync()).CanPublish = false; break;
                case "publish-only": (await database.ProjectAssignments.SingleAsync()).CanEdit = false; break;
                case "archived": (await database.Projects.SingleAsync()).IsArchived = true; break;
                case "anonymous": context = new DefaultHttpContext(); break;
                case "missing-session": context.Features.Set<Spatia.Server.Security.ValidatedAccountSession>(null); break;
                case "forged-stamp": (await database.Users.SingleAsync()).SecurityStamp = "changed"; break;
            }
            await database.SaveChangesAsync();
        }
        foreach (var request in new[] { existing, Request() })
        {
            var result = await fixture.PublishAsync(request, context);
            await Assert.That(result.AccessFailure).IsEqualTo((ProjectAccessFailure?)failure);
            await AssertNoAcknowledgementAsync(result);
            await Assert.That(result.CurrentRevision).IsNull();
            await Assert.That(result.Rejection).IsNull();
        }
        await fixture.AssertCountAsync(1);
    }

    [Test]
    [Arguments("revision")]
    [Arguments("intent")]
    [Arguments("whitespace")]
    [Arguments("actor")]
    [Arguments("project")]
    public async Task PublicationCoordinator_ChangedIdentityNeverReusesOrDisclosesAnEdition(string change)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        await fixture.PublishAsync(request);
        var original = await fixture.ReadAsync(request.PublicationId);
        var context = fixture.Context();
        var projectId = fixture.ProjectId;
        await using (var database = fixture.Database())
        {
            if (change == "actor")
            {
                var actorId = Guid.NewGuid();
                database.Users.Add(new ApplicationUser
                {
                    Id = actorId,
                    UserName = "other",
                    NormalizedUserName = "OTHER",
                    SecurityStamp = fixture.Stamp,
                    MustChangePassword = false
                });
                database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = actorId, RoleId = ApplicationRoles.CreatorId });
                database.OrganizationMemberships.Add(new OrganizationMembership
                {
                    UserId = actorId,
                    OrganizationId = fixture.OrganizationId,
                    RoleId = ApplicationRoles.CreatorId
                });
                database.ProjectAssignments.Add(new ProjectAssignment
                {
                    ProjectId = fixture.ProjectId,
                    UserId = actorId,
                    CanEdit = true,
                    CanPublish = true
                });
                context = fixture.Context(actorId);
            }
            if (change == "project")
            {
                projectId = await AddProjectAsync(fixture, database);
            }
            await database.SaveChangesAsync();
        }
        var altered = new PublicationRequest(request.PublicationId, change == "revision" ? 1 : 0,
            change == "intent" ? "{\"fixtureAudience\":\"changed\"}" : change == "whitespace" ? " " + Intent : Intent);
        await AssertRejectedAsync(await fixture.PublishAsync(altered, context, projectId), PublicationRejection.IdConflict);
        await Assert.That((await fixture.ReadAsync(request.PublicationId)).DocumentJson).IsEqualTo(original.DocumentJson);
        await fixture.AssertCountAsync(1);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationCoordinator_MissingIntegrationsDenyNewAndHistoricalRequests(bool replay)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        if (replay) { await fixture.PublishAsync(request); }
        await AssertRejectedAsync(await fixture.PublishAsync(request, unavailable: true), PublicationRejection.DependencyUnavailable);
        await fixture.AssertCountAsync(replay ? 1 : 0);
    }

    [Test]
    [Arguments("ApprovalRequired")]
    [Arguments("PolicyDenied")]
    [Arguments("DependencyUnavailable")]
    public async Task PublicationCoordinator_PreparationDenialLeavesNoEdition(string failureValue)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var failure = Enum.Parse<PublicationRejection>(failureValue);
        fixture.Integration.PreparationFailure = failure;
        await AssertRejectedAsync(await fixture.PublishAsync(Request()), failure);
        await Assert.That(fixture.Integration.Stages).IsEqualTo(0);
        await fixture.AssertCountAsync(0);
    }

    [Test]
    public async Task PublicationCoordinator_RevokedRetryDoesNotResetPolicyOrApproval()
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        var request = Request();
        await fixture.PublishAsync(request);
        fixture.Integration.ReplayFailure = PublicationRejection.PolicyDenied;
        await AssertRejectedAsync(await fixture.PublishAsync(request), PublicationRejection.PolicyDenied);
        await Assert.That(fixture.Integration.Stages).IsEqualTo(1);
        await Assert.That(fixture.Integration.Preparations).IsEqualTo(1);
        await fixture.AssertCountAsync(1);
    }

    [Test]
    [Arguments("missing")]
    [Arguments("duplicate")]
    [Arguments("case")]
    [Arguments("null")]
    public async Task PublicationCoordinator_IncompleteOrInvalidManifestCannotCommit(string change)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        fixture.Integration.ChangeReferences = references => change switch
        {
            "missing" => references.Skip(1).ToArray(),
            "duplicate" => [.. references, references[0]],
            "case" => references.Select(row => new PublicationAssetReference(row.AssetId.ToUpperInvariant(), row.Sha256)).ToArray(),
            _ => [null!],
        };
        await AssertRejectedAsync(await fixture.PublishAsync(Request()), PublicationRejection.InvalidAssets);
        await fixture.AssertCountAsync(0);
    }

    [Test]
    [Arguments("invalid-json")]
    [Arguments("schema")]
    [Arguments("route")]
    [Arguments("unsupported")]
    public async Task PublicationCoordinator_StoredDocumentMustValidateAndRunOnTarget(string change)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync(2);
        await using (var database = fixture.Database())
        {
            var project = await database.Projects.SingleAsync();
            // Simulate legacy/corrupt storage in this disposable schema to exercise the second
            // validation boundary. Ordinary writes already reject these metadata mismatches.
            if (change is "schema" or "route")
            {
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE projects DROP CONSTRAINT \"CK_projects_document\"");
            }
            switch (change)
            {
                case "invalid-json":
                    var incomplete = JsonNode.Parse(project.DocumentJson)!;
                    incomplete.AsObject().Remove("scenes");
                    project.DocumentJson = incomplete.ToJsonString();
                    break;
                case "schema": project.SchemaVersion = 1; break;
                case "route": project.DocumentJson = ProjectTestDocuments.Create(Guid.NewGuid(), "Wrong project", 2); break;
                default: fixture.Integration.RuntimeCapabilities = []; break;
            }
            await database.SaveChangesAsync();
        }
        await AssertRejectedAsync(await fixture.PublishAsync(Request()), change == "unsupported"
            ? PublicationRejection.UnsupportedRuntime : PublicationRejection.InvalidDocument);
        await fixture.AssertCountAsync(0);
    }

    [Test]
    [Arguments(-1L)]
    [Arguments(1L)]
    public async Task PublicationCoordinator_StaleOrFutureConfirmedRevisionHasNoSnapshot(long offset)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync(revision: 5);
        var result = await fixture.PublishAsync(Request(5 + offset));
        await AssertRejectedAsync(result, PublicationRejection.RevisionConflict, 5);
        await Assert.That(fixture.Integration.Preparations).IsEqualTo(0);
        await fixture.AssertCountAsync(0);
    }

    [Test]
    public async Task PublicationCoordinator_DoesNotJoinOrCommitCallerTransaction()
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync();
        await using var database = fixture.Database();
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Coordinator(database)
            .PublishAsync(fixture.Context(), fixture.ProjectId, Request()));
        await Assert.That(database.Database.CurrentTransaction).IsEqualTo(transaction);
        await fixture.AssertCountAsync(0);
    }

    private static async Task AssertCommittedAsync(PublicationResult result, PublicationRequest request, Guid projectId, bool replay)
    {
        await Assert.That(result.AccessFailure).IsNull();
        await Assert.That(result.Rejection).IsNull();
        await Assert.That(result.CurrentRevision).IsNull();
        await Assert.That(result.Acknowledgement).IsNotNull();
        await Assert.That(result.Acknowledgement!.PublicationId).IsEqualTo(request.PublicationId);
        await Assert.That(result.Acknowledgement.ProjectId).IsEqualTo(projectId);
        await Assert.That(result.Acknowledgement.SourceRevision).IsEqualTo(request.ConfirmedRevision);
        await Assert.That(result.Acknowledgement.CreatedAt.Offset).IsEqualTo(TimeSpan.Zero);
        await Assert.That(result.IsReplay).IsEqualTo(replay);
    }

    private static async Task AssertNoAcknowledgementAsync(PublicationResult result)
    {
        await Assert.That(result.Acknowledgement).IsNull();
        await Assert.That(result.IsReplay).IsFalse();
    }

    private static async Task AssertRejectedAsync(PublicationResult result, PublicationRejection failure, long? revision = null)
    {
        await AssertNoAcknowledgementAsync(result);
        await Assert.That(result.AccessFailure).IsNull();
        await Assert.That(result.Rejection).IsEqualTo((PublicationRejection?)failure);
        await Assert.That(result.CurrentRevision).IsEqualTo(revision);
    }

    private static async Task<Guid> AddProjectAsync(PublicationCoordinatorFixture fixture, Spatia.Server.Persistence.ApplicationDbContext database)
    {
        var id = Guid.NewGuid();
        database.Projects.Add(new Project
        {
            Id = id,
            OrganizationId = fixture.OrganizationId,
            SchemaVersion = 1,
            DocumentJson = ProjectTestDocuments.Create(id, "Other project"),
            UpdatedAt = DateTimeOffset.UnixEpoch
        });
        database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = fixture.ActorId, CanEdit = true, CanPublish = true });
        await database.SaveChangesAsync();
        return id;
    }
}
