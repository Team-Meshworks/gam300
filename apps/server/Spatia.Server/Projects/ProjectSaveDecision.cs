namespace Spatia.Server.Projects;

/// <summary>
/// Describes the revision and retry policy outcome for a proposed draft mutation
/// </summary>
public enum ProjectSaveDecision
{
    /// <summary>
    /// The expected revision or accepted mutation identity conflicts with the request
    /// </summary>
    Conflict,

    /// <summary>
    /// The request requires a new write after domain validation
    /// </summary>
    WriteRequired,

    /// <summary>
    /// The request matches a committed mutation and can reuse its original acknowledgement
    /// </summary>
    Replay,

    /// <summary>
    /// The current revision has reached the maximum safe integer and cannot be incremented
    /// </summary>
    RevisionExhausted,
}
