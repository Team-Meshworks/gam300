namespace Spatia.Server.Accounts;

public sealed class OrganizationMembership
{
    public Guid OrganizationId { get; set; }

    public Guid UserId { get; set; }

    public Guid RoleId { get; set; }
}
