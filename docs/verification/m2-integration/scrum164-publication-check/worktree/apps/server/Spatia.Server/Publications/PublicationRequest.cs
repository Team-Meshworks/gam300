using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

/// <summary>Internal coordinator input, not an HTTP DTO or an audience-policy definition</summary>
/// <remarks>
/// IntentJson retains every original policy input, including spelling and whitespace. The owning
/// integration must validate its complete schema and reject unknown fields before accepting it.
/// The future HTTP adapter must pass all accepted intent fields here, never a selected subset.
/// </remarks>
internal sealed class PublicationRequest
{
    internal const int MaxIntentBytes = 16 * 1024;

    public PublicationRequest(Guid publicationId, long confirmedRevision, string intentJson)
    {
        if (publicationId == Guid.Empty) { throw new ArgumentException("A publication ID is required.", nameof(publicationId)); }
        if (confirmedRevision < 0 || confirmedRevision > Project.MaxRevision)
        {
            throw new ArgumentOutOfRangeException(nameof(confirmedRevision));
        }
        ArgumentNullException.ThrowIfNull(intentJson);
        if (Encoding.UTF8.GetByteCount(intentJson) > MaxIntentBytes)
        {
            throw new ArgumentException("Publication intent exceeds its size limit.", nameof(intentJson));
        }
        using var parsed = JsonDocument.Parse(intentJson, new JsonDocumentOptions { MaxDepth = 16 });
        if (parsed.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("Publication intent must be an object.", nameof(intentJson));
        }
        PublicationId = publicationId;
        ConfirmedRevision = confirmedRevision;
        IntentJson = intentJson;
    }

    public Guid PublicationId { get; }
    public long ConfirmedRevision { get; }
    public string IntentJson { get; }

    public byte[] Digest(Guid projectId, Guid actorId)
    {
        if (projectId == Guid.Empty || actorId == Guid.Empty)
        {
            throw new ArgumentException("Project and actor IDs are required.");
        }
        // Fixed UUIDs and a newline-terminated invariant decimal frame the final original UTF-8 intent.
        // A future change to these semantics requires a new framing version, not a silent reinterpretation.
        return SHA256.HashData(Encoding.UTF8.GetBytes(
            $"spatia-publication-v1\n{PublicationId:D}\n{projectId:D}\n{actorId:D}\n"
            + ConfirmedRevision.ToString(CultureInfo.InvariantCulture) + "\n" + IntentJson));
    }
}
