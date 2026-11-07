using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.ProjectFormat;
using Spatia.Server.Assets;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

/// <summary>Stages agreed authenticated access and retained assets inside the publisher transaction</summary>
internal sealed class AuthenticatedPublicationIntegration : IPublicationIntegration
{
    public async Task<PublicationPreparation> PrepareAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, IAuthoredProject document, CancellationToken cancellationToken)
    {
        var intent = ReadIntent(request);
        if (intent.Failure is { } failure) { return PublicationPreparation.Denied(failure); }
        // The protected snapshot contract covers baseline exhibits; a visitor runtime capability contract is separate
        if (document is not LegacyProject { SchemaVersion: 1 } legacy
            || legacy.Scenes.Any(scene => scene.Interactions.Length != 0 || scene.Hotspots.Length != 0))
        {
            return PublicationPreparation.Denied(PublicationRejection.UnsupportedRuntime);
        }
        var viewers = intent.Viewers!;
        var eligible = await database.OrganizationMemberships.Where(member => member.OrganizationId == project.OrganizationId
            && viewers.Contains(member.UserId)
            && database.Organizations.Any(org => org.Id == member.OrganizationId && org.IsActive)
            && database.Users.Any(user => user.Id == member.UserId && user.IsActive && !user.MustChangePassword)
            && database.UserRoles.Any(role => role.UserId == member.UserId && role.RoleId == member.RoleId))
            .CountAsync(cancellationToken);
        if (eligible != viewers.Length) { return PublicationPreparation.Denied(PublicationRejection.PolicyDenied); }
        var references = await new ApprovedReviewAssetResolver().ResolveAsync(database, project,
            PublicationDocumentAssets.Required(document), cancellationToken);
        return references is null ? PublicationPreparation.Denied(PublicationRejection.InvalidAssets)
            : PublicationPreparation.Ready(references.Select(row => new PublicationAssetReference(row.AssetId, row.Sha256)), []);
    }

    public async Task<PublicationRejection?> AuthorizeReplayAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken)
    {
        if (ReadIntent(request).Failure is { } failure) { return failure; }
        // The coordinator already rechecks the original actor's current publish authority under the project lock
        // Do not reset audience or require approval for a later draft when acknowledging an existing edition
        var state = await database.PublicationAccess.AsNoTracking().SingleOrDefaultAsync(row => row.PublicationId == edition.Id, cancellationToken);
        return state is { Audience: (int)PublicationAudience.Authenticated, Hidden: false, Revoked: false, Deleted: false }
            ? null : PublicationRejection.PolicyDenied;
    }

    public async Task<PublicationRejection?> StageAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken)
    {
        var intent = ReadIntent(request);
        if (intent.Failure is { } failure) { return failure; }
        database.PublicationAccess.Add(new PublicationAccessState
        {
            PublicationId = edition.Id,
            Audience = (int)PublicationAudience.Authenticated,
            ViewerIds = intent.Viewers!,
        });
        await database.SaveChangesAsync(cancellationToken);
        return null;
    }

    private static (Guid[]? Viewers, PublicationRejection? Failure) ReadIntent(PublicationRequest request)
    {
        using var json = JsonDocument.Parse(request.IntentJson);
        var properties = json.RootElement.EnumerateObject().ToArray();
        if (properties.Length != 2 || properties.Count(item => item.Name == "audience") != 1
            || properties.Count(item => item.Name == "viewerIds") != 1
            || json.RootElement.GetProperty("audience").ValueKind != JsonValueKind.String
            || json.RootElement.GetProperty("viewerIds").ValueKind != JsonValueKind.Array)
        { return (null, PublicationRejection.PolicyDenied); }
        var audience = json.RootElement.GetProperty("audience").GetString();
        // Public/unlisted continuity and unknown-origin policy await their owners' contract
        if (audience is "Public" or "Unlisted") { return (null, PublicationRejection.DependencyUnavailable); }
        if (audience != "Authenticated") { return (null, PublicationRejection.PolicyDenied); }
        var ids = new HashSet<Guid>();
        var values = json.RootElement.GetProperty("viewerIds");
        if (values.GetArrayLength() > 100) { return (null, PublicationRejection.PolicyDenied); }
        foreach (var value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String || !value.TryGetGuid(out var id) || id == Guid.Empty || !ids.Add(id))
            { return (null, PublicationRejection.PolicyDenied); }
        }
        return (ids.ToArray(), null);
    }
}
