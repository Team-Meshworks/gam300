using System.Collections.Immutable;

namespace Spatia.Server.Projects;

/// <summary>
/// Captures authorized project state and effective permissions for server-side access and save decisions
/// </summary>
/// <param name="ActorId">The account whose authority was checked</param>
/// <param name="ProjectId">The authorized project's identifier</param>
/// <param name="OrganizationId">The organization that owns the project</param>
/// <param name="IsArchived">Whether the project is archived</param>
/// <param name="Revision">The current persisted revision</param>
/// <param name="SchemaVersion">The schema version stored alongside the document</param>
/// <param name="UnvalidatedDocumentJson">The stored project JSON awaiting domain validation and reconstruction</param>
/// <param name="UpdatedAt">The persisted update timestamp for the current revision</param>
/// <param name="LastMutationActorId">The latest remembered mutation's actor, or null when absent</param>
/// <param name="LastMutationId">The latest remembered mutation identifier, or null when absent</param>
/// <param name="LastMutationDigest">The immutable 32-byte digest, or null when no mutation is remembered</param>
/// <param name="CanEdit">Whether the actor can edit the current draft</param>
/// <param name="CanManage">Whether the actor can manage project access and archive state</param>
/// <param name="CanPublish">Whether the actor can publish the current project</param>
/// <remarks>
/// This server-side snapshot includes mutation metadata that must be excluded from public project responses
/// </remarks>
// TODO: Validate and reconstruct UnvalidatedDocumentJson through SCRUM-50 before consuming authored content
// TODO: Build the public GET envelope from SCRUM-50-accepted content without actor IDs or mutation digests
public sealed record ProjectAccessSnapshot(
    Guid ActorId,
    Guid ProjectId,
    Guid OrganizationId,
    bool IsArchived,
    long Revision,
    int SchemaVersion,
    string UnvalidatedDocumentJson,
    DateTimeOffset UpdatedAt,
    Guid? LastMutationActorId,
    Guid? LastMutationId,
    ImmutableArray<byte>? LastMutationDigest,
    bool CanEdit,
    bool CanManage,
    bool CanPublish);
