namespace Spatia.Server.Projects;

/// <summary>
/// Holds parsed request fields whose document still requires independent domain validation
/// </summary>
/// <param name="ExpectedRevision">The nonnegative safe integer revision the client intends to replace</param>
/// <param name="ClientMutationId">The identifier reused when retrying the same mutation</param>
/// <param name="UnvalidatedDocumentJson">The original document JSON awaiting domain validation</param>
// TODO: Integrate SCRUM-50 validation before consumers ingest or save UnvalidatedDocumentJson
public sealed record ParsedSaveEnvelope(
    long ExpectedRevision,
    Guid ClientMutationId,
    string UnvalidatedDocumentJson);
