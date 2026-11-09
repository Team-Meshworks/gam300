using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

public sealed record TextComponent(string Id, TextRun[] Runs, string Caption,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SpatialTransform? Placement = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Background = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double? FontSize = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Color = null) : ContentComponent(Id);
