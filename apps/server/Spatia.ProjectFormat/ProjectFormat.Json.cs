using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Spatia.ProjectFormat;

// Keep duplicate-field handling and browser-compatible JSON output together
public static partial class ProjectFormat
{
    private static void DuplicateFields(JsonElement value)
    {
        // Compare decoded names so escaped spellings cannot hide duplicate JSON fields
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    Fail("project", "Project JSON contains duplicate fields");
                }

                DuplicateFields(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                DuplicateFields(item);
            }
        }
        else if (value.ValueKind == JsonValueKind.String)
        {
            // Force decoding even for fields later rejected by structure checks, exposing malformed Unicode
            _ = value.GetString();
        }
    }

    private sealed class ExactStringConverter : JsonConverter<string>
    {
        // Use browser-compatible escaping when producing files, not the server's default escaping
        public override string? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => reader.GetString();
        public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        {
            // Reject malformed UTF-16 instead of silently replacing authored characters
            for (var i = 0; i < value.Length; i++)
            {
                if (char.IsHighSurrogate(value[i]))
                {
                    if (i + 1 == value.Length || !char.IsLowSurrogate(value[++i]))
                    {
                        throw new JsonException();
                    }
                }
                else if (char.IsLowSurrogate(value[i]))
                {
                    throw new JsonException();
                }
            }

            // Match browser string escaping so Unicode does not inflate the shared byte budget
            var json = new StringBuilder(value.Length + 2).Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"': json.Append("\\\""); break;
                    case '\\': json.Append("\\\\"); break;
                    case '\b': json.Append("\\b"); break;
                    case '\f': json.Append("\\f"); break;
                    case '\n': json.Append("\\n"); break;
                    case '\r': json.Append("\\r"); break;
                    case '\t': json.Append("\\t"); break;
                    default:
                        if (character < ' ')
                        {
                            json.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            json.Append(character);
                        }

                        break;
                }
            }

            // The converter has produced a complete quoted JSON string with validated UTF-16
            writer.WriteRawValue(json.Append('"').ToString());
        }
    }

    private sealed class BrowserNumberConverter : JsonConverter<double>
    {
        // Keep equivalent values the same size in browser and server output near the file limit
        public override double Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => reader.GetDouble();
        public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options)
        {
            if (!double.IsFinite(value))
            {
                throw new JsonException();
            }

            // JSON.stringify emits zero for either sign of zero
            if (value == 0) { writer.WriteNumberValue(0); return; }

            // Keep browser decimal/exponent thresholds and avoid padded exponent digits
            var text = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
            var exponentAt = text.IndexOf('E');
            if (exponentAt >= 0)
            {
                var exponent = int.Parse(text[(exponentAt + 1)..], CultureInfo.InvariantCulture);
                var mantissa = text[..exponentAt];
                if (exponent is >= -6 and < 21)
                {
                    // Expand round-trip digits into decimal notation within the browser's decimal range
                    var digits = mantissa.Replace(".", "", StringComparison.Ordinal);
                    var point = exponent + 1;
                    text = point <= 0 ? "0." + new string('0', -point) + digits
                        : point >= digits.Length ? digits + new string('0', point - digits.Length)
                        : digits.Insert(point, ".");
                }
                else
                {
                    // Outside that range use a lowercase exponent with an explicit positive sign
                    text = mantissa + "e" + (exponent >= 0 ? "+" : "-") + Math.Abs(exponent).ToString(CultureInfo.InvariantCulture);
                }
            }
            writer.WriteRawValue((value < 0 ? "-" : "") + text);
        }
    }
}
