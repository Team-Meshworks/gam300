namespace Spatia.Server.Persistence;

internal sealed class LegacyCreationBinding
{
    public Guid ActorId
    {
        get; init;
    }
    public required byte[] IntentDigest
    {
        get; init;
    }
    public required string Kind
    {
        get; init;
    }
    public required string Purpose
    {
        get; init;
    }
    public Guid OrganizationId
    {
        get; init;
    }
    public Guid? SourceProjectId
    {
        get; init;
    }
    public Guid ResourceId
    {
        get; init;
    }
    public Guid? OperationId
    {
        get; init;
    }
    public Guid? PreviousOperationId
    {
        get; init;
    }
}
