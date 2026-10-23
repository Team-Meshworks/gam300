namespace Spatia.Server.Projects;

/// <summary>
/// Contains a committed save acknowledgement, an access denial or a revision rejection
/// </summary>
public sealed class ProjectSaveResult
{
    private ProjectSaveResult(ProjectSaveAcknowledgement? acknowledgement, ProjectAccessFailure? accessFailure,
        ProjectSaveDecision? rejection, long? currentRevision)
    {
        Acknowledgement = acknowledgement;
        AccessFailure = accessFailure;
        Rejection = rejection;
        CurrentRevision = currentRevision;
    }

    /// <summary>
    /// Gets the acknowledgement of a confirmed commit or retry, or null when the save was not acknowledged
    /// </summary>
    public ProjectSaveAcknowledgement? Acknowledgement { get; }

    /// <summary>
    /// Gets the access denial, or null when the outcome is not an authorization failure
    /// </summary>
    public ProjectAccessFailure? AccessFailure { get; }

    /// <summary>
    /// Gets the conflict or revision exhaustion decision, or null when no revision rejection occurred
    /// </summary>
    public ProjectSaveDecision? Rejection { get; }

    /// <summary>
    /// Gets the current revision accompanying a revision rejection, or null for other outcomes
    /// </summary>
    public long? CurrentRevision { get; }

    internal static ProjectSaveResult Committed(ProjectSaveAcknowledgement acknowledgement) =>
        new(acknowledgement, null, null, null);

    internal static ProjectSaveResult Denied(ProjectAccessFailure failure) => new(null, failure, null, null);

    internal static ProjectSaveResult Rejected(ProjectSaveDecision decision, long currentRevision) =>
        new(null, null, decision, currentRevision);
}
