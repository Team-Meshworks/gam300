namespace Spatia.Server.Accounts;

public static class ApplicationRoles
{
    public const string Administrator = "Administrator";
    public const string Educator = "Educator";
    public const string Creator = "Creator";

    public static readonly Guid AdministratorId = new("7e815748-1cd1-4018-b4b8-0e578f5508cd");
    public static readonly Guid EducatorId = new("d14c51b6-510a-4430-a27c-bfdc6e9d801b");
    public static readonly Guid CreatorId = new("862d776c-4d56-4dd8-919d-26044b6d8a44");
}
