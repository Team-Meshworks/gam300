using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

[JsonConverter(typeof(JsonStringEnumConverter<TextMark>))]
public enum TextMark
{
    [JsonStringEnumMemberName("bold")] Bold,
    [JsonStringEnumMemberName("italic")] Italic,
    [JsonStringEnumMemberName("underline")] Underline,
}
