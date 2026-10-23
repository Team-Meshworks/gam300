namespace Spatia.Server.Accounts;

/// <summary>
/// Carries credentials and authority assignments for an administrator-provisioned account
/// </summary>
public sealed class ProvisionAccountRequest
{
    /// <summary>
    /// Gets the requested account username
    /// </summary>
    public required string UserName { get; init; }

    /// <summary>
    /// Gets the temporary password that must be changed after first sign-in
    /// </summary>
    public required string InitialPassword { get; init; }

    /// <summary>
    /// Gets the active organization identifier for educators and creators, or null for administrators
    /// </summary>
    public required Guid? OrgId { get; init; }

    /// <summary>
    /// Gets one of the fixed role names defined by <see cref="ApplicationRoles"/>
    /// </summary>
    public required string Role { get; init; }
}
