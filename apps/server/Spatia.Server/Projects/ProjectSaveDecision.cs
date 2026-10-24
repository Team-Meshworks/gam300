namespace Spatia.Server.Projects;

/// <summary>
/// Describes the revision and retry policy outcome for a proposed draft mutation
/// </summary>
public enum ProjectSaveDecision
{
    /// <summary>
    /// The expected revision or latest mutation metadata conflicts with the request
    /// </summary>
    Conflict,

    /// <summary>
    /// The request requires a new write after domain validation
    /// </summary>
    // TODO: Consume WriteRequired in a save only after SCRUM-50 document validation
    WriteRequired,

    /// <summary>
    /// The request matches the latest committed mutation and can reuse its acknowledgement
    /// </summary>
    Replay,

    /// <summary>
    /// The current revision has reached the maximum safe integer and cannot be incremented
    /// </summary>
    RevisionExhausted,
}
