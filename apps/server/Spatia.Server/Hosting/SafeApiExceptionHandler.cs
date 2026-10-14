using Microsoft.AspNetCore.Diagnostics;
using Npgsql;

namespace Spatia.Server.Hosting;

public sealed class SafeApiExceptionHandler(ILogger<SafeApiExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        (int Status, string Code, string Title) failure = exception switch
        {
            NpgsqlException or TimeoutException
                or InvalidOperationException { InnerException: NpgsqlException or TimeoutException }
                => (503, "storage_unavailable", "Storage is unavailable"),
            BadHttpRequestException { StatusCode: 413 } => (413, "request_too_large", "The request is too large"),
            BadHttpRequestException => (400, "invalid_request", "The request is invalid"),
            _ => (500, "internal_error", "The request could not be completed"),
        };
        logger.LogError("request_failure {Code} {StatusCode} {TraceId}",
            failure.Code, failure.Status, httpContext.TraceIdentifier);
        await ApiProblems.Create(httpContext, failure.Status, failure.Code, failure.Title).ExecuteAsync(httpContext);
        return true;
    }
}
