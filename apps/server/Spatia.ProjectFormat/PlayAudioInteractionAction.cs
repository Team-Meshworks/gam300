using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

// Keep old URL actions readable while new actions retain the scene audio identity
public sealed record PlayAudioInteractionAction(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Url = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? MediaId = null) : InteractionAction;
