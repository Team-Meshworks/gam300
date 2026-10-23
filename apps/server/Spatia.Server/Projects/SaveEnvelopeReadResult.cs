namespace Spatia.Server.Projects;

/// <summary>
/// Contains either a parsed save envelope or the request error that prevented parsing
/// </summary>
public sealed class SaveEnvelopeReadResult
{
    private SaveEnvelopeReadResult(ParsedSaveEnvelope? envelope, SaveEnvelopeError? error)
    {
        Envelope = envelope;
        Error = error;
    }

    /// <summary>
    /// Gets the parsed envelope, or null when reading failed
    /// </summary>
    public ParsedSaveEnvelope? Envelope { get; }

    /// <summary>
    /// Gets the request error, or null when an envelope was parsed successfully
    /// </summary>
    public SaveEnvelopeError? Error { get; }

    /// <summary>
    /// Creates a successful read result without asserting that its document passed domain validation
    /// </summary>
    /// <param name="envelope">The parsed request envelope</param>
    /// <returns>A result containing the envelope and no error</returns>
    /// <exception cref="ArgumentNullException"><paramref name="envelope"/> is null</exception>
    public static SaveEnvelopeReadResult Success(ParsedSaveEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        return new(envelope, null);
    }

    /// <summary>
    /// Creates a failed read result containing a safe request error
    /// </summary>
    /// <param name="error">The request error that prevented an envelope from being accepted</param>
    /// <returns>A result containing the error and no envelope</returns>
    /// <exception cref="ArgumentNullException"><paramref name="error"/> is null</exception>
    public static SaveEnvelopeReadResult Failure(SaveEnvelopeError error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return new(null, error);
    }
}
