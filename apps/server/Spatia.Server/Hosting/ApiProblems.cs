using Microsoft.AspNetCore.Http.HttpResults;

namespace Spatia.Server.Hosting;

public static class ApiProblems
{
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
