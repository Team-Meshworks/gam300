namespace Spatia.Server.Projects;

public enum ProjectSaveDecision
{
    Conflict,
    // TODO: Consume WriteRequired in a save only after SCRUM-50 document validation
    WriteRequired,
    Replay,
    RevisionExhausted,
}
