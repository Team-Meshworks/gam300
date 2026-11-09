namespace Spatia.Server.Publications;

// Keep mutable access restrictions separate from the immutable publication and its asset manifest
public sealed class PublicationAccessState
{
    public Guid PublicationId { get; set; }
    // Default to authenticated access; a missing decision must never expose an edition publicly
    public int Audience { get; set; } = 3;

    // Keep each restriction independent when the publication is hidden, revoked or permanently deleted
    public bool Hidden { get; set; }
    public bool Revoked { get; set; }
    public bool Deleted { get; set; }

    // Store named identities only; eligibility and project-derived permissions are checked on each request
    public Guid[] ViewerIds { get; set; } = [];
}
