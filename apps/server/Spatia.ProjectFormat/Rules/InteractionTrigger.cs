using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

// Scene interactions use their own tag vocabulary, separate from content rule triggers
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(VisitorClicksHotspotTrigger), "visitor-clicks-hotspot")]
[JsonDerivedType(typeof(SceneStartsTrigger), "scene-starts")]
[JsonDerivedType(typeof(TimeElapsedTrigger), "time-elapsed")]
public abstract record InteractionTrigger;
