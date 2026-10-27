namespace Spatia.ProjectFormat;

public sealed record FormatResult<T>(T? Value, FormatIssue? Error)
{
    public bool Ok => Error is null;
}
