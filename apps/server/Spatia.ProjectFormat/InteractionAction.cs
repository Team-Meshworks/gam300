using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

// Scene interaction actions use kebab-case tags, separate from content rule actions
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(OpenLinkInteractionAction), "open-link")]
[JsonDerivedType(typeof(PlayAudioInteractionAction), "play-audio")]
[JsonDerivedType(typeof(PrintHiInteractionAction), "print-hi")]
[JsonDerivedType(typeof(NavigateSceneInteractionAction), "navigate-scene")]
[JsonDerivedType(typeof(MoveToViewpointInteractionAction), "move-to-viewpoint")]
public abstract record InteractionAction;
