namespace Spatia.Server.Projects;

/// <summary>Parsed request fields; the document still requires independent domain validation</summary>
public sealed record ParsedSaveEnvelope(
    long ExpectedRevision,
    Guid ClientMutationId,
    string UnvalidatedDocumentJson);
