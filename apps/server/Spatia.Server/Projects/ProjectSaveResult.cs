namespace Spatia.Server.Projects;

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

    public ProjectSaveAcknowledgement? Acknowledgement { get; }

    public ProjectAccessFailure? AccessFailure { get; }

    public ProjectSaveDecision? Rejection { get; }

    public long? CurrentRevision { get; }

    internal static ProjectSaveResult Committed(ProjectSaveAcknowledgement acknowledgement) =>
        new(acknowledgement, null, null, null);

    internal static ProjectSaveResult Denied(ProjectAccessFailure failure) => new(null, failure, null, null);

    internal static ProjectSaveResult Rejected(ProjectSaveDecision decision, long currentRevision) =>
        new(null, null, decision, currentRevision);
}
