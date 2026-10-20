using Microsoft.AspNetCore.Antiforgery;
using Spatia.Server.Hosting;

namespace Spatia.Server.Security;

public sealed class CsrfGuardMiddleware(RequestDelegate next)
{
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
