namespace Spatia.Server.Hosting;

internal static class CommittedWrite
{
    internal static IResult WithoutRepresentation(HttpContext context)
    {
        // The write committed, but authorization changed before its representation could be returned.
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Remove("WWW-Authenticate");
        context.Response.Headers["X-Spatia-Write-Outcome"] = "committed";
        return Results.NoContent();
    }
}
