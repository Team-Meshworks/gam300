namespace Spatia.Server.Accounts;

/// <summary>
/// Associates an educator or creator with an organization and the matching Identity role
/// </summary>
public sealed class OrganizationMembership
{
    /// <summary>
    /// Gets or sets the organization to which the account belongs
    /// </summary>
    public Guid OrganizationId { get; set; }

    /// <summary>
    /// Gets or sets the member account identifier
    /// </summary>
    public Guid UserId { get; set; }

    /// <summary>
    /// Gets or sets the educator or creator role identifier, which must match the account's Identity role
    /// </summary>
    public Guid RoleId { get; set; }
}
