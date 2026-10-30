namespace Spatia.Server.Accounts;

/// <summary>
/// Defines the fixed Identity role names and their seeded database identifiers
/// </summary>
public static class ApplicationRoles
{
    /// <summary>
    /// The role name for application administrators
    /// </summary>
    public const string Administrator = "Administrator";

    /// <summary>
    /// The role name for organization educators
    /// </summary>
    public const string Educator = "Educator";

    /// <summary>
    /// The role name for organization creators
    /// </summary>
    public const string Creator = "Creator";

    /// <summary>
    /// The stable identifier of the seeded administrator role
    /// </summary>
    public static readonly Guid AdministratorId = new("7e815748-1cd1-4018-b4b8-0e578f5508cd");

    /// <summary>
    /// The stable identifier of the seeded educator role
    /// </summary>
    public static readonly Guid EducatorId = new("d14c51b6-510a-4430-a27c-bfdc6e9d801b");

    /// <summary>
    /// The stable identifier of the seeded creator role
    /// </summary>
    public static readonly Guid CreatorId = new("862d776c-4d56-4dd8-919d-26044b6d8a44");
}
