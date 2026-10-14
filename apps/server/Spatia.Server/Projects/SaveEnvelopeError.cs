namespace Spatia.Server.Projects;

public sealed record SaveEnvelopeError(int StatusCode, string Code, string Path, string Message);
