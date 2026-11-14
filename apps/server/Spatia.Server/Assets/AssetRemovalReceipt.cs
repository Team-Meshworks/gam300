namespace Spatia.Server.Assets;

internal sealed class AssetRemovalReceipt
{
    public Guid ActorId { get; init; }
    public Guid OperationId { get; init; }
    public Guid AssetId { get; init; }
    public bool Applied { get; set; }
}
