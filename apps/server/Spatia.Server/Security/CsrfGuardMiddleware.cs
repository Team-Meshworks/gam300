using Microsoft.AspNetCore.Antiforgery;
using Spatia.Server.Hosting;

namespace Spatia.Server.Security;

/// <summary>
/// Requires valid antiforgery tokens on requests other than GET, HEAD and OPTIONS
/// </summary>
/// <param name="next">The next middleware delegate to invoke after successful validation</param>
public sealed class CsrfGuardMiddleware(RequestDelegate next)
{
    /// <summary>
    /// Validates unsafe requests and returns a safe 400 problem when their antiforgery token is missing or invalid
    /// </summary>
    /// <param name="context">The HTTP request being checked</param>
    /// <param name="antiforgery">The service that validates the request token and matching cookie</param>
    /// <returns>A task completing after rejection or execution of the next middleware</returns>
    public async Task InvokeAsync(HttpContext context, IAntiforgery antiforgery)
    {
        if (HttpMethods.IsGet(context.Request.Method)
            || HttpMethods.IsHead(context.Request.Method)
            || HttpMethods.IsOptions(context.Request.Method))
        {
            await next(context);
            return;
        }

        var header = context.Request.Headers["X-CSRF-TOKEN"];
        if (header.Count != 1 || string.IsNullOrWhiteSpace(header[0]))
        {
            await ApiProblems.Create(context, 400, "csrf_invalid", "A valid request token is required.")
                .ExecuteAsync(context);
            return;
        }

        try
        {
            await antiforgery.ValidateRequestAsync(context);
        }
        catch (AntiforgeryValidationException)
        {
            await ApiProblems.Create(context, 400, "csrf_invalid", "A valid request token is required.")
                .ExecuteAsync(context);
            return;
        }

        await next(context);
    }
}
