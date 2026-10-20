using System.Collections.Immutable;

namespace Spatia.Server.Projects;

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
