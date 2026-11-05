namespace Spatia.Server.Publications;

internal static class PublicationReadEndpointExtensions
{
    internal static RouteHandlerBuilder RequirePublicationRead(
        this RouteHandlerBuilder endpoint,
        PublicationReadKind kind)
    {
        // Allow anonymous requests through to the filter so public and unlisted links can work
        return endpoint.AllowAnonymous().AddEndpointFilter(new PublicationReadFilter(kind));
    }
}
