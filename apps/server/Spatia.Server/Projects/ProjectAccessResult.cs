namespace Spatia.Server.Projects;

public sealed class ProjectAccessResult
{
    private ProjectAccessResult(ProjectAccessSnapshot? snapshot, ProjectAccessFailure? failure)
    {
        Snapshot = snapshot;
        Failure = failure;
    }

    public ProjectAccessSnapshot? Snapshot { get; }

    public ProjectAccessFailure? Failure { get; }

    internal static ProjectAccessResult Granted(ProjectAccessSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return new(snapshot, null);
    }

    internal static ProjectAccessResult Denied(ProjectAccessFailure failure) => new(null, failure);
}
