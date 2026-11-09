using Spatia.Server.Projects;

namespace Spatia.Server.Publications;

/// <summary>Internal failures contain no private document, manifest, policy or conflicting identity</summary>
internal enum PublicationRejection
{
    RevisionConflict,
    IdConflict,
    InvalidDocument,
    UnsupportedRuntime,
    InvalidAssets,
    DependencyUnavailable,
    ApprovalRequired,
    PolicyDenied,
}

/// <summary>Facts read from a committed edition; visitor URLs are added by the later HTTP boundary</summary>
internal sealed record PublicationAcknowledgement(Guid PublicationId, Guid ProjectId, long SourceRevision, DateTimeOffset CreatedAt);

internal sealed class PublicationResult
{
    private PublicationResult(PublicationAcknowledgement? acknowledgement = null, bool replay = false,
        ProjectAccessFailure? accessFailure = null, PublicationRejection? rejection = null, long? currentRevision = null)
    {
        Acknowledgement = acknowledgement;
        IsReplay = replay;
        AccessFailure = accessFailure;
        Rejection = rejection;
        CurrentRevision = currentRevision;
    }

    public PublicationAcknowledgement? Acknowledgement { get; }
    public bool IsReplay { get; }
    public ProjectAccessFailure? AccessFailure { get; }
    public PublicationRejection? Rejection { get; }
    public long? CurrentRevision { get; }

    internal static PublicationResult Denied(ProjectAccessFailure failure) => new(accessFailure: failure);
    internal static PublicationResult Rejected(PublicationRejection rejection, long? currentRevision = null) =>
        new(rejection: rejection, currentRevision: currentRevision);
    internal static PublicationResult Committed(Publication row, bool replay) =>
        new(new(row.Id, row.ProjectId, row.SourceRevision, row.CreatedAt), replay);
}
