namespace Spatia.Server.Classes;

/// <summary>Stores a class within the organization that owns its roster and assignments.</summary>
public sealed class Classroom
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public required string Name { get; set; }
}
