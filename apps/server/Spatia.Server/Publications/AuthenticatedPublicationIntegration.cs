using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.ProjectFormat;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

/// <summary>Stages agreed authenticated access and retained assets inside the publisher transaction</summary>
internal sealed class AuthenticatedPublicationIntegration(IHostEnvironment environment, IConfiguration configuration) : IPublicationIntegration
{
    private readonly Dictionary<string, DevelopmentPublicationAssets.Asset> _developmentAssets = new(StringComparer.Ordinal);
    public async Task<PublicationPreparation> PrepareAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, IAuthoredProject document, CancellationToken cancellationToken)
    {
        var intent = ReadIntent(request);
        if (intent.Failure is { } failure) { return PublicationPreparation.Denied(failure); }
        // URL-only audio has no retained bytes or current publication access decision
        // Require a captured library component while preserving authored rules and hotspots
        var hasUncapturedAudio = document switch
        {
            LegacyProject legacy => legacy.Scenes.Any(scene => scene.Interactions.Any(item => item.Do is PlayAudioInteractionAction { Url: not null })),
            ContentProject content => content.Scenes.Any(scene => scene.Interactions.Any(item => item.Do is PlayAudioInteractionAction { Url: not null })),
            _ => true,
        };
        var missing = ProjectCapabilities.Missing(document, PublicationCapabilities.Supported);
        if (hasUncapturedAudio || missing.Count != 0)
        {
            return PublicationPreparation.Denied(PublicationRejection.UnsupportedRuntime, missing);
        }
        var viewers = intent.Viewers!;
        var eligible = await database.OrganizationMemberships.Where(member => member.OrganizationId == project.OrganizationId
            && viewers.Contains(member.UserId)
            && database.Organizations.Any(org => org.Id == member.OrganizationId && org.IsActive)
            && database.Users.Any(user => user.Id == member.UserId && user.IsActive && !user.MustChangePassword)
            && database.UserRoles.Any(role => role.UserId == member.UserId && role.RoleId == member.RoleId))
            .CountAsync(cancellationToken);
        if (eligible != viewers.Length) { return PublicationPreparation.Denied(PublicationRejection.PolicyDenied); }
        var required = PublicationDocumentAssets.Required(document);
        var approvedIds = required.Where(id => Guid.TryParseExact(id, "D", out var parsed) && parsed.ToString() == id)
            .ToHashSet(StringComparer.Ordinal);
        var references = await new ApprovedReviewAssetResolver().ResolveAsync(database, project, approvedIds, cancellationToken);
        if (references is null) { return PublicationPreparation.Denied(PublicationRejection.InvalidAssets); }
        _developmentAssets.Clear();
        var development = new DevelopmentPublicationAssets(environment, configuration);
        foreach (var id in required.Except(approvedIds, StringComparer.Ordinal))
        {
            var asset = await development.ReadAsync(id, cancellationToken);
            if (asset is null) { return PublicationPreparation.Denied(PublicationRejection.InvalidAssets); }
            _developmentAssets.Add(id, asset);
        }
        return PublicationPreparation.Ready(references.Select(row => new PublicationAssetReference(row.AssetId, row.Sha256))
            .Concat(_developmentAssets.Values.Select(asset => new PublicationAssetReference(asset.Id, asset.Sha256))), PublicationCapabilities.Supported);
    }

    public async Task<PublicationRejection?> AuthorizeReplayAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken)
    {
        var intent = ReadIntent(request);
        if (intent.Failure is { } failure) { return failure; }
        // The coordinator already rechecks the original actor's current publish authority under the project lock
        // Do not reset audience or require approval for a later draft when acknowledging an existing edition
        var state = await database.PublicationAccess.AsNoTracking().SingleOrDefaultAsync(row => row.PublicationId == edition.Id, cancellationToken);
        return state is { Hidden: false, Revoked: false, Deleted: false } && state.Audience == (int)intent.Audience
            ? null : PublicationRejection.PolicyDenied;
    }

    public async Task<PublicationRejection?> StageAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken)
    {
        var intent = ReadIntent(request);
        if (intent.Failure is { } failure) { return failure; }
        var references = JsonSerializer.Deserialize<PublicationAssetReference[]>(edition.AssetReferencesJson);
        if (references is null) { return PublicationRejection.InvalidAssets; }
        foreach (var reference in references.Where(row => !Guid.TryParseExact(row.AssetId, "D", out _)))
        {
            if (!_developmentAssets.TryGetValue(reference.AssetId, out var asset) || asset.Sha256 != reference.Sha256)
            { return PublicationRejection.InvalidAssets; }
            var bytes = await DevelopmentPublicationAssets.ReadBytesAsync(asset, cancellationToken);
            if (bytes is null) { return PublicationRejection.InvalidAssets; }
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO development_publication_blobs (sha256, bytes) VALUES ({asset.Sha256}, {bytes})
                ON CONFLICT (sha256) DO NOTHING
                """, cancellationToken);
            var stored = await database.Database.SqlQuery<byte[]>($"SELECT bytes AS \"Value\" FROM development_publication_blobs WHERE sha256 = {asset.Sha256}")
                .SingleAsync(cancellationToken);
            if (!stored.AsSpan().SequenceEqual(bytes)) { return PublicationRejection.InvalidAssets; }
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO development_publication_assets (publication_id, asset_id, kind, media_type, sha256)
                VALUES ({edition.Id}, {asset.Id}, {asset.Kind}, {asset.MediaType}, {asset.Sha256})
                """, cancellationToken);
        }
        database.PublicationAccess.Add(new PublicationAccessState
        {
            PublicationId = edition.Id,
            Audience = (int)intent.Audience,
            ViewerIds = intent.Viewers!,
        });
        await database.SaveChangesAsync(cancellationToken);
        return null;
    }

    private static (Guid[]? Viewers, PublicationAudience Audience, PublicationRejection? Failure) ReadIntent(PublicationRequest request)
    {
        using var json = JsonDocument.Parse(request.IntentJson);
        var properties = json.RootElement.EnumerateObject().ToArray();
        if (properties.Length is not (2 or 3) || properties.Count(item => item.Name == "audience") != 1
            || (properties.Length == 3 && properties.Count(item => item.Name == "teacherOverride" && item.Value.ValueKind == JsonValueKind.True) != 1)
            || properties.Count(item => item.Name == "viewerIds") != 1
            || json.RootElement.GetProperty("audience").ValueKind != JsonValueKind.String
            || json.RootElement.GetProperty("viewerIds").ValueKind != JsonValueKind.Array)
        { return (null, default, PublicationRejection.PolicyDenied); }
        var audience = json.RootElement.GetProperty("audience").GetString();
        if (audience is not ("Authenticated" or "Unlisted" or "Public")) { return (null, default, PublicationRejection.PolicyDenied); }
        var ids = new HashSet<Guid>();
        var values = json.RootElement.GetProperty("viewerIds");
        if (values.GetArrayLength() > 100 || (audience != "Authenticated" && values.GetArrayLength() != 0)) { return (null, default, PublicationRejection.PolicyDenied); }
        foreach (var value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String || !value.TryGetGuid(out var id) || id == Guid.Empty || !ids.Add(id))
            { return (null, default, PublicationRejection.PolicyDenied); }
        }
        return (ids.ToArray(), Enum.Parse<PublicationAudience>(audience!), null);
    }
}
