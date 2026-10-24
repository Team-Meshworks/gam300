namespace Spatia.Server.Projects;

/// <summary>
/// Contains either an authorized project snapshot or an access denial
/// </summary>
public sealed class ProjectAccessResult
{
    private ProjectAccessResult(ProjectAccessSnapshot? snapshot, ProjectAccessFailure? failure)
    {
        Snapshot = snapshot;
        Failure = failure;
    }

    /// <summary>
    /// Gets the authorized snapshot, or null when access was denied
    /// </summary>
    public ProjectAccessSnapshot? Snapshot { get; }

    /// <summary>
    /// Gets the access denial, or null when access was granted
    /// </summary>
    public ProjectAccessFailure? Failure { get; }

    internal static ProjectAccessResult Granted(ProjectAccessSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return new(snapshot, null);
    }

    internal static ProjectAccessResult Denied(ProjectAccessFailure failure) => new(null, failure);
}
