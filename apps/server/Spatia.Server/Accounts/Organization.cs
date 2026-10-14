namespace Spatia.Server.Accounts;

public sealed class Organization
{
    public Guid Id { get; set; }

    public required string Name { get; set; }

    public bool IsActive { get; set; } = true;
}
