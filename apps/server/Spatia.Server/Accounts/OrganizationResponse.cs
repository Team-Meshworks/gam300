namespace Spatia.Server.Accounts;

/// <summary>
/// Describes an organization returned by administration operations
/// </summary>
/// <param name="Id">The organization's persistent identifier</param>
/// <param name="Name">The organization's display name</param>
/// <param name="IsActive">Whether the organization supports active member accounts</param>
public sealed record OrganizationResponse(Guid Id, string Name, bool IsActive);
