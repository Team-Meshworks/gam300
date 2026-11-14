namespace Spatia.Server.Accounts;

internal sealed class BulkImportReceipt
{
    public Guid ActorId { get; init; }
    public Guid OrganizationId { get; init; }
    public Guid OperationId { get; init; }
    public byte[]? ProtectedIntent { get; set; }
    public required string CreatedJson { get; set; }
    public byte[]? ProtectedHandoff { get; set; }
    public DateTimeOffset ExpiresAt { get; init; }
    public bool Acknowledged { get; set; }
}
