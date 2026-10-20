namespace Spatia.Server.Projects;

public sealed class SaveEnvelopeReadResult
{
    private SaveEnvelopeReadResult(ParsedSaveEnvelope? envelope, SaveEnvelopeError? error)
    {
        Envelope = envelope;
        Error = error;
    }

    public ParsedSaveEnvelope? Envelope { get; }

    public SaveEnvelopeError? Error { get; }

    public static SaveEnvelopeReadResult Success(ParsedSaveEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        return new(envelope, null);
    }

    public static SaveEnvelopeReadResult Failure(SaveEnvelopeError error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return new(null, error);
    }
}
