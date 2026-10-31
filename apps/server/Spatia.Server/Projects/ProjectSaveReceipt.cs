namespace Spatia.Server.Projects;

/// <summary>
/// Retains one committed save's request identity and original acknowledgement for the project's lifetime
/// </summary>
public sealed class ProjectSaveReceipt
{
    /// <summary>Gets or sets the project whose save committed</summary>
    public Guid ProjectId { get; set; }

    /// <summary>Gets or sets the mutation identifier unique within that project</summary>
    public Guid ClientMutationId { get; set; }

    /// <summary>Gets or sets the authenticated actor who committed the save</summary>
    public Guid ActorId { get; set; }

    /// <summary>Gets or sets the original expected revision</summary>
    public long ExpectedRevision { get; set; }

    /// <summary>Gets or sets the revision committed by this save</summary>
    public long Revision { get; set; }

    /// <summary>Gets or sets the server-derived SHA-256 fingerprint of the original request</summary>
    public byte[] RequestDigest { get; set; } = [];

    /// <summary>Gets or sets the original committed save timestamp</summary>
    public DateTimeOffset SavedAt { get; set; }
}
