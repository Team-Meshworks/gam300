using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Publications;

// Rebuild visitor authority from the current project, account and independent lifecycle restrictions
internal sealed class StoredPublicationAccessReader(ApplicationDbContext database, ProjectAccessService access,
    IHttpContextAccessor contexts, IHostEnvironment environment) : IPublicationAccessReader
{
    public async ValueTask<PublicationReadPolicy?> ReadAsync(Guid publicationId, string? assetId,
        CurrentAccount? account, CancellationToken token)
    {
        // Retired links stay unavailable even if older policy data is restored
        if (await database.Database.SqlQuery<Guid>($"SELECT id AS \"Value\" FROM retired_publication_ids WHERE id = {publicationId}").AnyAsync(token)) { return null; }

        var edition = await database.Publications.AsNoTracking().SingleOrDefaultAsync(row => row.Id == publicationId, token);
        var state = await database.PublicationAccess.AsNoTracking().SingleOrDefaultAsync(row => row.PublicationId == publicationId, token);
        if (edition is null || state is null) { return null; }

        var references = System.Text.Json.JsonSerializer.Deserialize<PublicationAssetReference[]>(edition.AssetReferencesJson)!;
        if (!environment.IsDevelopment() && references.Any(reference =>
            !Guid.TryParseExact(reference.AssetId, "D", out var parsed) || parsed.ToString() != reference.AssetId)) { return null; }

        // Pin asset delivery to the edition's exact reviewed fingerprint and current global-removal flag
        if (assetId is not null)
        {
            var reference = references.SingleOrDefault(item => item.AssetId == assetId);
            if (reference is null) { return null; }
            if (Guid.TryParseExact(assetId, "D", out var id) && id.ToString() == assetId)
            {
                if (!await database.AssetCandidates.AnyAsync(row => row.Id == id && row.Status == "approved"
                    && !row.RemovedFromProjects && row.Sha256 == reference.Sha256, token)) { return null; }
            }
            else if (!environment.IsDevelopment() || !await database.Database.SqlQuery<int>($"""
                SELECT 1 AS "Value" FROM development_publication_assets
                WHERE publication_id = {publicationId} AND asset_id = {assetId} AND sha256 = {reference.Sha256}
                """).AnyAsync(token)) { return null; }
        }
        var project = await database.Projects.AsNoTracking().SingleOrDefaultAsync(row => row.Id == edition.ProjectId, token);
        if (project is null) { return null; }

        // Named visitors need no draft permission; permission-derived viewers reuse the existing authority service
        var grant = account is null ? null : (await access.ReadAsync(contexts.HttpContext!, project.Id, token)).Snapshot;
        return PublicationReadPolicy.FromCurrentState((PublicationAudience)state.Audience, project.IsArchived,
            state.Hidden, state.Revoked, state.Deleted, project.OrganizationId, edition.PublishedById, account,
            account is not null && state.ViewerIds.Contains(account.UserId), grant?.CanEdit ?? false,
            grant?.CanPublish ?? false, grant?.CanManage ?? false);
    }
}
