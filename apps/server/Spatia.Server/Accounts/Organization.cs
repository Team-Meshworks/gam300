namespace Spatia.Server.Accounts;

/// <summary>
/// Stores an organization and the active state required for its members' account access
/// </summary>
public sealed class Organization
{
    /// <summary>
    /// Gets or sets the organization's persistent identifier
    /// </summary>
    public Guid Id { get; set; }

    /// <summary>
    /// Gets or sets the organization's display name
    /// </summary>
    public required string Name { get; set; }

    /// <summary>
    /// Gets or sets whether the organization can support active member sessions and new memberships
    /// </summary>
    public bool IsActive { get; set; } = true;
}
