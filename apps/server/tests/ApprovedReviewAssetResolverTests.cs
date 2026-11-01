using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Reviews;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ApprovedReviewAssetResolverTests
{
    [Test]
    [Arguments("pending")]
    [Arguments("invalid")]
    [Arguments("removed")]
    [Arguments("missing")]
    [Arguments("alias")]
    [Arguments("sample")]
    public async Task Resolver_RejectsIncompleteVersionsAndLeavesTheCallerTransactionIntact(string unavailable)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var actor = await fixture.CreateAccountAsync();
        await using var scope = fixture.App.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var resolver = scope.ServiceProvider.GetRequiredService<IReviewAssetResolver>();
        var room = Candidate("environment", actor);
        var model = Candidate("model", actor);
        if (unavailable == "alias") { model.Id = Guid.Parse("abcdefab-1234-4abc-8abc-0123456789ab"); }
        if (unavailable is "pending" or "invalid") { model.Status = unavailable; }
        if (unavailable == "removed")
        {
            model.Hidden = true;
            model.Deleted = true;
            model.RemovedFromProjects = true;
        }

        // An uncommitted catalogue version is visible in the existing transaction without granting the resolver commit ownership
        await using var transaction = await database.Database.BeginTransactionAsync();
        database.AssetCandidates.AddRange(room, model);
        await database.SaveChangesAsync();
        var requestedModel = unavailable switch
        {
            "missing" => Guid.NewGuid().ToString(),
            "alias" => model.Id.ToString().ToUpperInvariant(),
            "sample" => "test-crate-v1",
            _ => model.Id.ToString(),
        };
        var required = new HashSet<string>([room.Id.ToString(), requestedModel], StringComparer.Ordinal);
        var project = new ProjectAccessSnapshot(actor, Guid.NewGuid(), Guid.NewGuid(), false, 0, 1, "{}",
            DateTimeOffset.UnixEpoch, null, null, null, true, false, false);
        var resolved = await resolver.ResolveAsync(database, project, required, default);
        await Assert.That(resolved).IsNull();
        await Assert.That(ReferenceEquals(database.Database.CurrentTransaction, transaction)).IsTrue();

        // Reject the whole manifest and leave every write available for the caller to roll back
        await transaction.RollbackAsync();
        await Assert.That(await database.AssetCandidates.AsNoTracking().CountAsync()).IsEqualTo(0);
        await Assert.That(await database.ReviewSubmissions.CountAsync()).IsEqualTo(0);
    }

    private static AssetCandidate Candidate(string kind, Guid actor)
    {
        // Distinct synthetic byte sequences make the persisted fingerprints meaningful in the manifest assertion
        byte[] bytes = kind == "environment" ? [1, 2, 3] : [4, 5, 6];
        return new()
        {
            Id = Guid.NewGuid(),
            Name = "Reviewed " + kind,
            Kind = kind,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            Bytes = bytes,
            Status = "approved",
            ValidationJson = "[]",
            Hidden = false,
            Source = "Synthetic review fixture",
            License = "Synthetic fixture only",
            ReviewNotes = "Approved test version",
            SubmittedBy = actor,
            ReviewedBy = actor,
            CreatedAt = DateTimeOffset.UtcNow,
        };
    }
}
