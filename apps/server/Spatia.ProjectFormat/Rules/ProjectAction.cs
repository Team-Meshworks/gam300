using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(ShowPanelAction), "showPanel")]
[JsonDerivedType(typeof(PlayMediaAction), "playMedia")]
[JsonDerivedType(typeof(MoveCameraAction), "moveCamera")]
[JsonDerivedType(typeof(SetVisibleAction), "setVisible")]
[JsonDerivedType(typeof(NavigateSceneAction), "navigateScene")]
[JsonDerivedType(typeof(OpenLinkAction), "openLink")]
public abstract record ProjectAction;
