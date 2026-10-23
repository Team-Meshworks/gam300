namespace Spatia.Server.Projects;

/// <summary>
/// Describes a save request failure without including private request content
/// </summary>
/// <param name="StatusCode">The HTTP status appropriate for the request failure</param>
/// <param name="Code">The stable error code for clients</param>
/// <param name="Path">The request field path associated with the failure</param>
/// <param name="Message">The safe description of the violated request requirement</param>
public sealed record SaveEnvelopeError(int StatusCode, string Code, string Path, string Message);
