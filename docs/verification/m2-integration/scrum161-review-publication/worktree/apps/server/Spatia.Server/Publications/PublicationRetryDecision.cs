namespace Spatia.Server.Publications;

/// <summary>Describes an identity comparison only; none of these outcomes authorizes publication</summary>
public enum PublicationRetryDecision
{
    /// <summary>No edition has claimed the supplied publication ID</summary>
    CreateRequired,

    /// <summary>The persisted edition records the same request identity</summary>
    Replay,

    /// <summary>The ID already belongs to a different request identity</summary>
    Conflict,
}
