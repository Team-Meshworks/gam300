namespace Spatia.Server.Hosting;

/// <summary>Binds a new creation to the actor's last observed generation for a purpose.</summary>
public sealed record CreationGuard
{
    /// <summary>Gets the creation purpose used to discover and acknowledge operations.</summary>
    public required string Purpose { get; init; }
    /// <summary>Gets the ready generation's operation ID, or null before the first creation.</summary>
    public required Guid? PreviousOperationId { get; init; }
}
