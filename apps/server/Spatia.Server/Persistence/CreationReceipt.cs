namespace Spatia.Server.Persistence;

internal sealed class CreationReceipt
{
    public Guid ActorId { get; init; }
    public Guid OperationId { get; init; }
    public long Sequence { get; init; }
    public string Purpose { get; init; } = "project";
    public bool Acknowledged { get; set; }
    public Guid? SourceProjectId { get; set; }
    public required string Kind { get; init; }
    public required byte[] RequestDigest { get; init; }
    public Guid ResourceId { get; init; }
    public string? ResponseJson { get; init; }
}
