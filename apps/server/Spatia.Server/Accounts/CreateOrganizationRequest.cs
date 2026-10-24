namespace Spatia.Server.Accounts;

/// <summary>
/// Carries the name of an organization to create
/// </summary>
public sealed class CreateOrganizationRequest
{
    /// <summary>
    /// Gets the nonblank organization name, limited to 256 characters
    /// </summary>
    public required string Name { get; init; }
}
