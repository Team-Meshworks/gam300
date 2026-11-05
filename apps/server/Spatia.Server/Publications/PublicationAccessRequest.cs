namespace Spatia.Server.Publications;

// Bound the named audience and action at the endpoint before changing durable visitor access
internal sealed record PublicationAccessRequest(string Audience, Guid[] ViewerIds, string Action);
