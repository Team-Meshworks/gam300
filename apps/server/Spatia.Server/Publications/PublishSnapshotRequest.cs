using System.Text.Json;

namespace Spatia.Server.Publications;

internal sealed record PublishSnapshotRequest(Guid? PublicationId, long? ConfirmedRevision, JsonElement Intent);
