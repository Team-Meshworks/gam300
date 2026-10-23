using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Spatia.Server.Projects;

/// <summary>
/// Reads bounded save requests and checks envelope syntax and project identity before domain validation
/// </summary>
public static class SaveEnvelopeReader
{
    /// <summary>
    /// The maximum UTF-8 request body size in bytes, including the save envelope
    /// </summary>
    public const int MaxRequestBytes = 6 * 1024 * 1024;
    private const int MaxDocumentBytes = 5 * 1024 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    /// <summary>
    /// Checks bounded request syntax and route identity without validating project content
    /// </summary>
    /// <param name="request">The UTF-8 JSON request whose body is consumed up to the size limit plus one byte</param>
    /// <param name="routeProjectId">The route identifier that the document's project identifier must match</param>
    /// <param name="cancellationToken">The token used to cancel body reading and parsing preparation</param>
    /// <returns>The parsed envelope with unvalidated document JSON, or a safe request error</returns>
    /// <remarks>
    /// TODO: Integrate SCRUM-50 validation after this bounded reader before enabling production save handlers
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null</exception>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    /// <exception cref="IOException">The request body cannot be read</exception>
    public static async Task<SaveEnvelopeReadResult> ReadAsync(
        HttpRequest request,
        Guid routeProjectId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (request.ContentLength > MaxRequestBytes)
        {
            return Failure(413, "request_too_large", "request", "Request exceeds the 6 MiB limit");
        }

        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var contentType)
            || !string.Equals(contentType.MediaType.Value, "application/json", StringComparison.OrdinalIgnoreCase)
            || (contentType.Charset.HasValue
                && !string.Equals(HeaderUtilities.RemoveQuotes(contentType.Charset).Value, "utf-8", StringComparison.OrdinalIgnoreCase)))
        {
            return Failure(415, "unsupported_media_type", "request", "Expected UTF-8 application/json");
        }

        var contentEncoding = request.Headers.ContentEncoding.ToString();
        if (contentEncoding.Length != 0
            && !string.Equals(contentEncoding, "identity", StringComparison.OrdinalIgnoreCase))
        {
            return Failure(415, "unsupported_content_encoding", "request", "Compressed request bodies are unsupported");
        }

        using var body = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var remaining = MaxRequestBytes + 1 - (int)body.Length;
            var count = await request.Body.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remaining)), cancellationToken);
            if (count == 0)
            {
                break;
            }

            body.Write(buffer, 0, count);
            if (body.Length > MaxRequestBytes)
            {
                return Failure(413, "request_too_large", "request", "Request exceeds the 6 MiB limit");
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        var bytes = body.ToArray();
        try
        {
            StrictUtf8.GetCharCount(bytes);
            using var json = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 33 });
            return ParseEnvelope(json.RootElement, routeProjectId);
        }
        catch (DecoderFallbackException)
        {
            return InvalidJson();
        }
        catch (JsonException)
        {
            return InvalidJson();
        }
    }

    private static SaveEnvelopeReadResult ParseEnvelope(JsonElement root, Guid routeProjectId)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return InvalidEnvelope();
        }

        var seen = 0;
        JsonElement revision = default;
        JsonElement mutationId = default;
        JsonElement document = default;
        foreach (var property in root.EnumerateObject())
        {
            int field;
            if (HasName(property, "expectedRevision"))
            {
                field = 1;
                revision = property.Value;
            }
            else if (HasName(property, "clientMutationId"))
            {
                field = 2;
                mutationId = property.Value;
            }
            else if (HasName(property, "document"))
            {
                field = 4;
                document = property.Value;
            }
            else
            {
                return InvalidEnvelope();
            }

            if ((seen & field) != 0)
            {
                return InvalidEnvelope();
            }

            seen |= field;
        }

        if (seen != 7)
        {
            return InvalidEnvelope();
        }

        if (revision.ValueKind != JsonValueKind.Number
            || !revision.TryGetInt64(out var expectedRevision)
            || expectedRevision < 0
            || expectedRevision > Project.MaxRevision)
        {
            return Failure(400, "invalid_expected_revision", "expectedRevision", "Expected a nonnegative safe integer revision");
        }

        if (!TryReadGuid(mutationId, out var clientMutationId))
        {
            return Failure(400, "invalid_client_mutation_id", "clientMutationId", "Expected a UUID in 8-4-4-4-12 form");
        }

        if (document.ValueKind != JsonValueKind.Object)
        {
            return Failure(400, "invalid_document", "document", "Expected a project JSON object");
        }

        var documentJson = document.GetRawText();
        if (StrictUtf8.GetByteCount(documentJson) > MaxDocumentBytes)
        {
            return Failure(413, "document_too_large", "document", "Document exceeds the 5 MiB limit");
        }

        JsonElement projectId = default;
        var hasProjectId = false;
        foreach (var property in document.EnumerateObject())
        {
            if (!HasName(property, "projectId"))
            {
                continue;
            }

            if (hasProjectId)
            {
                return InvalidProjectId();
            }

            hasProjectId = true;
            projectId = property.Value;
        }

        if (!hasProjectId || !TryReadGuid(projectId, out var documentProjectId))
        {
            return InvalidProjectId();
        }

        if (documentProjectId != routeProjectId)
        {
            return Failure(422, "project_id_mismatch", "document.projectId", "Document project ID does not match the route");
        }

        // TODO: Apply SCRUM-50 validation to this original JSON, including duplicate/unknown keys and references, before jsonb storage
        return SaveEnvelopeReadResult.Success(new(expectedRevision, clientMutationId, documentJson));
    }

    private static bool HasName(JsonProperty property, string name)
    {
        try
        {
            return property.NameEquals(name);
        }
        catch (InvalidOperationException)
        {
            // An escaped unpaired surrogate cannot match a known field name
            return false;
        }
    }

    private static bool TryReadGuid(JsonElement value, out Guid id)
    {
        id = default;
        if (value.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        string? text;
        try
        {
            text = value.GetString();
        }
        catch (InvalidOperationException)
        {
            // Escaped unpaired surrogates cannot form a decoded UUID string
            return false;
        }

        return text is { Length: 36 } && Guid.TryParseExact(text, "D", out id);
    }

    private static SaveEnvelopeReadResult InvalidJson() =>
        Failure(400, "invalid_json", "request", "Request JSON is malformed, invalid UTF-8 or too deeply nested");

    private static SaveEnvelopeReadResult InvalidEnvelope() =>
        Failure(400, "invalid_envelope", "request", "Expected exactly expectedRevision, clientMutationId and document");

    private static SaveEnvelopeReadResult InvalidProjectId() =>
        Failure(422, "invalid_project_id", "document.projectId", "Expected exactly one projectId UUID in the document");

    private static SaveEnvelopeReadResult Failure(int statusCode, string code, string path, string message) =>
        SaveEnvelopeReadResult.Failure(new(statusCode, code, path, message));
}
