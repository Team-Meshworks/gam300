namespace Spatia.Server.Accounts;

/// <summary>
/// Requests a reversible account or organization lifecycle state
/// </summary>
public sealed class SetActiveRequest
{
    /// <summary>
    /// Gets the desired stored active state
    /// </summary>
    public required bool IsActive { get; init; }
}
