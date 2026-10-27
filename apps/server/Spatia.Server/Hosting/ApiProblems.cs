using Microsoft.AspNetCore.Http.HttpResults;

namespace Spatia.Server.Hosting;

/// <summary>
/// Creates consistent API problem responses with safe error codes and request trace identifiers
/// </summary>
public static class ApiProblems
{
    /// <summary>
    /// Creates a problem result and disables caching for the current response
    /// </summary>
    /// <param name="context">The request context supplying the trace identifier and response headers</param>
    /// <param name="status">The HTTP status code for the problem</param>
    /// <param name="code">The stable error code that clients can interpret</param>
    /// <param name="title">The client-safe description, excluding credentials and private request content</param>
    /// <returns>A problem result containing the supplied status, code, title and request trace identifier</returns>
    public static ProblemHttpResult Create(HttpContext context, int status, string code, string title)
    {
        context.Response.Headers.CacheControl = "no-store";
        return TypedResults.Problem(
            statusCode: status,
            title: title,
            extensions: new Dictionary<string, object?>
            {
                ["code"] = code,
                ["traceId"] = context.TraceIdentifier,
            });
    }
}
