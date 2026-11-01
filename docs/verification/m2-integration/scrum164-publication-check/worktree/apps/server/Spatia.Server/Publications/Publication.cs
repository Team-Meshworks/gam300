namespace Spatia.Server.Publications;

/// <summary>
/// Stores one immutable edition and its durable retry identity; access policy is owned separately
/// </summary>
/// <remarks>
/// This is an internal persistence boundary, not a publish request or public response.
/// The publication coordinator must authorize, validate and capture the exact saved revision
/// under the shared project lock before inserting it. PostgreSQL rejects subsequent updates.
/// </remarks>
public sealed class Publication
{
    /// <summary>Gets the stable identifier reused for retries of this edition</summary>
    public Guid Id { get; init; }

    /// <summary>Gets the source project; current access must be checked independently of this record</summary>
    public Guid ProjectId { get; init; }

    /// <summary>Gets the account that requested this edition</summary>
    public Guid PublishedById { get; init; }

    /// <summary>Gets the exact saved revision captured by this edition</summary>
    public long SourceRevision { get; init; }

    /// <summary>Gets the format version matching the immutable document</summary>
    public int SchemaVersion { get; init; }

    /// <summary>Gets the complete snapshot stored as PostgreSQL jsonb</summary>
    public required string DocumentJson { get; init; }

    /// <summary>Gets the complete immutable asset ID and SHA-256 manifest stored with the snapshot</summary>
    public required string AssetReferencesJson { get; init; }

    /// <summary>Gets the server-derived SHA-256 digest of the original publication request</summary>
    public required byte[] RequestDigest { get; init; }

    /// <summary>Gets the database-generated insertion timestamp, visible to callers only after commit</summary>
    public DateTimeOffset CreatedAt { get; private set; }
}
