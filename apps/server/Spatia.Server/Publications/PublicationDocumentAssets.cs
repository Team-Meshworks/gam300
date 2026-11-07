using Spatia.ProjectFormat;

namespace Spatia.Server.Publications;

/// <summary>Collects authored references only after full format validation; resolution belongs to SCRUM-73</summary>
internal static class PublicationDocumentAssets
{
    public static HashSet<string> Required(IAuthoredProject document)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        switch (document)
        {
            case LegacyProject { SchemaVersion: 1 } legacy:
                foreach (var scene in legacy.Scenes)
                {
                    ids.Add(scene.EnvironmentAssetId);
                    foreach (var item in scene.Objects) { ids.Add(item.AssetId); }
                }
                break;
            case ContentProject { SchemaVersion: 2 } content:
                foreach (var scene in content.Scenes)
                {
                    ids.Add(scene.EnvironmentAssetId);
                    // Include scene audio in retained references even while its playback remains unavailable
                    foreach (var audio in (scene.Audio ?? []).OfType<AudioComponent>()) { ids.Add(audio.AssetId); }
                    foreach (var item in scene.Objects)
                    {
                        ids.Add(item.AssetId);
                        foreach (var component in item.Components)
                        {
                            switch (component)
                            {
                                case ImageComponent image: ids.Add(image.AssetId); break;
                                case AudioComponent audio: ids.Add(audio.AssetId); break;
                                case VideoComponent video: ids.Add(video.AssetId); break;
                            }
                        }
                    }
                }
                break;
            default:
                throw new ArgumentException("Assets require a validated supported project.", nameof(document));
        }
        return ids;
    }
}
