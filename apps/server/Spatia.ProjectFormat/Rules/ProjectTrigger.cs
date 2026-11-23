using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(ClickTrigger), "click")]
[JsonDerivedType(typeof(ZoneEnterTrigger), "zoneEnter")]
[JsonDerivedType(typeof(SceneStartTrigger), "sceneStart")]
[JsonDerivedType(typeof(ElapsedTrigger), "elapsed")]
[JsonDerivedType(typeof(GazeTrigger), "gaze")]
[JsonDerivedType(typeof(PanelCloseTrigger), "panelClose")]
public abstract record ProjectTrigger;
