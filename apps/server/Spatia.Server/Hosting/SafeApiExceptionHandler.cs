using Microsoft.AspNetCore.Diagnostics;
using Npgsql;

namespace Spatia.Server.Hosting;

/// <summary>
/// Converts unhandled request failures into safe problems without logging exception details or request bodies
/// </summary>
/// <param name="logger">The logger for error codes, status codes and trace identifiers</param>
public sealed class SafeApiExceptionHandler(ILogger<SafeApiExceptionHandler> logger) : IExceptionHandler
{
    /// <summary>
    /// Classifies a request failure, logs safe metadata and writes the corresponding problem response
    /// </summary>
    /// <param name="httpContext">The request context receiving the problem response</param>
    /// <param name="exception">The exception used to select a safe status and error code</param>
    /// <param name="cancellationToken">The middleware-supplied cancellation token, not directly observed here</param>
    /// <returns>True after the problem response has been written</returns>
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
