using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

[JsonConverter(typeof(JsonStringEnumConverter<AudioMode>))]
public enum AudioMode
{
    [JsonStringEnumMemberName("spatial")] Spatial,
    [JsonStringEnumMemberName("global")] Global,
}
