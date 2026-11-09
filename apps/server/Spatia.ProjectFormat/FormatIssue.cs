namespace Spatia.ProjectFormat;

// Readers return either a checked value or an error path for import feedback
public sealed record FormatIssue(string Path, string Message);
