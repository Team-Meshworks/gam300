using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

// Map each saved type tag to a concrete record; unknown tags must not become partial components
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(HotspotComponent), "hotspot")]
[JsonDerivedType(typeof(TextComponent), "text")]
[JsonDerivedType(typeof(ImageComponent), "image")]
[JsonDerivedType(typeof(AudioComponent), "audio")]
[JsonDerivedType(typeof(VideoComponent), "video")]
[JsonDerivedType(typeof(NavigationPointComponent), "navigationPoint")]
public abstract record ContentComponent(string Id);
