namespace Spatia.Server.Projects;

/// <summary>Parsed request fields; the document still requires independent domain validation</summary>
// TODO: Integrate SCRUM-50 validation before consumers ingest or save UnvalidatedDocumentJson
public sealed record ParsedSaveEnvelope(
    long ExpectedRevision,
    Guid ClientMutationId,
    string UnvalidatedDocumentJson);
