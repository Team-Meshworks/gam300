using Spatia.ProjectFormat;
using Spatia.Server.Reviews;

namespace Spatia.Server.Publications;

/// <summary>Uses the same authored references as review evidence; resolution belongs to SCRUM-73</summary>
internal static class PublicationDocumentAssets
{
    public static HashSet<string> Required(IAuthoredProject document) => ReviewAssetManifest.Required(document);
}
