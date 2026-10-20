using System.Text;
using Microsoft.AspNetCore.Http;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class SaveEnvelopeReaderTests
{
    private const string ProjectId = "11111111-1111-4111-8111-111111111111";
    private const string MutationId = "44444444-4444-4444-8444-444444444444";
    private const int RequestLimit = 6 * 1024 * 1024;
    private const int DocumentLimit = 5 * 1024 * 1024;
    private static readonly Guid RouteId = Guid.Parse(ProjectId);
    private static readonly string MinimalDocument = $$"""{"projectId":"{{ProjectId}}"}""";

    [Test]
    public async Task ReadAsync_MinimalDocument_ReturnsParsedUnvalidatedEnvelope()
    {
        var result = await ReadAsync(CreateEnvelope(MinimalDocument));

        var envelope = RequireEnvelope(result);
        await Assert.That(envelope.ExpectedRevision).IsEqualTo(0L);
        await Assert.That(envelope.ClientMutationId).IsEqualTo(Guid.Parse(MutationId));
        await Assert.That(envelope.UnvalidatedDocumentJson).IsEqualTo(MinimalDocument);
        await Assert.That(result.Error).IsNull();
    }

    [Test]
    public async Task ReadAsync_ReorderedProperties_PreservesUnvalidatedDocumentText()
    {
        var document = $$"""{ "projectId":"{{ProjectId}}", "unknown": "学校 { }", "nested": {"x":1,"x":2} }""";
        var json = $$"""{ "document": {{document}}, "clientMutationId": "{{MutationId}}", "expectedRevision": 2 }""";

        var result = await ReadAsync(json);

        await Assert.That(RequireEnvelope(result).UnvalidatedDocumentJson).IsEqualTo(document);
    }

    [Test]
    [Arguments("0", 0L)]
    [Arguments("9007199254740991", 9007199254740991L)]
    public async Task ReadAsync_ExactRevisionBoundary_Succeeds(string token, long expected)
    {
        var result = await ReadAsync(CreateEnvelope(MinimalDocument, token));

        await Assert.That(RequireEnvelope(result).ExpectedRevision).IsEqualTo(expected);
    }

    [Test]
    [Arguments("-1")]
    [Arguments("9007199254740992")]
    [Arguments("9223372036854775808")]
    [Arguments("1.0")]
    [Arguments("1e0")]
    [Arguments("\"1\"")]
    [Arguments("null")]
    [Arguments("true")]
    public async Task ReadAsync_NonExactRevision_ReturnsMemberError(string token)
    {
        await AssertErrorAsync(await ReadAsync(CreateEnvelope(MinimalDocument, token)),
            400, "invalid_expected_revision", "expectedRevision");
    }

    [Test]
    [Arguments("{}")]
    [Arguments("[]")]
    [Arguments("null")]
    [Arguments("{\"expectedRevision\":0}")]
    public async Task ReadAsync_MissingEnvelopeOrWrongRoot_ReturnsEnvelopeError(string json)
    {
        await AssertErrorAsync(await ReadAsync(json), 400, "invalid_envelope", "request");
    }

    [Test]
    [Arguments("\"owner\":\"someone\",")]
    [Arguments("\"expectedRevision\":1,")]
    [Arguments("\"clientMutationId\":\"44444444-4444-4444-8444-444444444444\",")]
    [Arguments("\"document\":{},")]
    public async Task ReadAsync_UnknownOrDuplicateEnvelopeMember_ReturnsEnvelopeError(string additionalMember)
    {
        var json = CreateEnvelope(MinimalDocument).Insert(1, additionalMember);

        await AssertErrorAsync(await ReadAsync(json), 400, "invalid_envelope", "request");
    }

    [Test]
    public async Task ReadAsync_CaseChangedEnvelopeKey_ReturnsEnvelopeError()
    {
        var json = CreateEnvelope(MinimalDocument).Replace("expectedRevision", "ExpectedRevision", StringComparison.Ordinal);

        await AssertErrorAsync(await ReadAsync(json), 400, "invalid_envelope", "request");
    }

    [Test]
    [Arguments("\"\\u0064ocument\":{},")]
    [Arguments("\"\\u0065xpectedRevision\":1,")]
    [Arguments("\"\\uD800xx\":0,")]
    public async Task ReadAsync_EscapedDuplicateOrInvalidEnvelopeName_ReturnsSafeEnvelopeError(string member)
    {
        await AssertErrorAsync(await ReadAsync(CreateEnvelope(MinimalDocument).Insert(1, member)),
            400, "invalid_envelope", "request");
    }

    [Test]
    [Arguments("\"bad\"")]
    [Arguments("\"44444444444444448444444444444444\"")]
    [Arguments("\"{44444444-4444-4444-8444-444444444444}\"")]
    [Arguments("null")]
    [Arguments("1")]
    [Arguments("\"\\uD800\"")]
    public async Task ReadAsync_NonCanonicalMutationUuid_ReturnsMemberError(string token)
    {
        var json = $$"""{"expectedRevision":0,"clientMutationId":{{token}},"document":{{MinimalDocument}}}""";

        await AssertErrorAsync(await ReadAsync(json), 400, "invalid_client_mutation_id", "clientMutationId");
    }

    [Test]
    [Arguments("[]")]
    [Arguments("null")]
    [Arguments("\"text\"")]
    public async Task ReadAsync_NonObjectDocument_ReturnsDocumentError(string document)
    {
        await AssertErrorAsync(await ReadAsync(CreateEnvelope(document)), 400, "invalid_document", "document");
    }

    [Test]
    [Arguments("{}")]
    [Arguments("{\"projectId\":null}")]
    [Arguments("{\"projectId\":1}")]
    [Arguments("{\"projectId\":\"11111111111141118111111111111111\"}")]
    [Arguments("{\"projectId\":\"\\uD800\"}")]
    [Arguments("{\"projectId\":\"11111111-1111-4111-8111-111111111111\",\"projectId\":\"11111111-1111-4111-8111-111111111111\"}")]
    public async Task ReadAsync_MissingInvalidOrDuplicateDocumentId_ReturnsBindingError(string document)
    {
        await AssertErrorAsync(await ReadAsync(CreateEnvelope(document)), 422, "invalid_project_id", "document.projectId");
    }

    [Test]
    public async Task ReadAsync_DifferentDocumentId_ReturnsMismatchWithoutContent()
    {
        var document = "{\"projectId\":\"22222222-2222-4222-8222-222222222222\",\"private\":\"secret marker\"}";

        var result = await ReadAsync(CreateEnvelope(document));

        await AssertErrorAsync(result, 422, "project_id_mismatch", "document.projectId");
        await Assert.That(result.Error!.Message).DoesNotContain("secret marker");
    }

    [Test]
    public async Task ReadAsync_EscapedRootIdAndUppercaseUuid_BindsByGuidValue()
    {
        var id = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
        var document = $$"""{"project\u0049d":"{{id.ToUpperInvariant()}}"}""";

        var result = await SaveEnvelopeReader.ReadAsync(CreateRequest(CreateEnvelope(document)), Guid.Parse(id));

        await Assert.That(RequireEnvelope(result).UnvalidatedDocumentJson).IsEqualTo(document);
    }

    [Test]
    public async Task ReadAsync_EscapedDuplicateDocumentId_ReturnsBindingError()
    {
        var document = $$"""{"projectId":"{{ProjectId}}","project\u0049d":"{{ProjectId}}"}""";

        await AssertErrorAsync(await ReadAsync(CreateEnvelope(document)),
            422, "invalid_project_id", "document.projectId");
    }

    [Test]
    public async Task ReadAsync_UnknownSurrogateDocumentName_RemainsUnvalidated()
    {
        var document = $$"""{"projectId":"{{ProjectId}}","\uD800abc":1}""";

        var result = await ReadAsync(CreateEnvelope(document));

        await Assert.That(RequireEnvelope(result).UnvalidatedDocumentJson).IsEqualTo(document);
    }

    [Test]
    public async Task ReadAsync_EscapedUppercaseMutationUuid_Succeeds()
    {
        var token = "\"\\u0041BCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF\"";
        var json = $$"""{"expectedRevision":0,"clientMutationId":{{token}},"document":{{MinimalDocument}}}""";

        var result = await ReadAsync(json);

        await Assert.That(RequireEnvelope(result).ClientMutationId).IsEqualTo(Guid.Parse("abcdefab-abcd-4abc-8abc-abcdefabcdef"));
    }

    [Test]
    [Arguments(32, true)]
    [Arguments(33, false)]
    public async Task ReadAsync_DocumentDepth_CountsEnvelopeLevel(int documentDepth, bool allowed)
    {
        var nested = new string('[', documentDepth - 1) + "0" + new string(']', documentDepth - 1);
        var document = $$"""{"projectId":"{{ProjectId}}","nested":{{nested}}}""";
        var result = await ReadAsync(CreateEnvelope(document));

        if (allowed)
        {
            await Assert.That(RequireEnvelope(result).UnvalidatedDocumentJson).IsEqualTo(document);
        }
        else
        {
            await AssertErrorAsync(result, 400, "invalid_json", "request");
        }
    }

    [Test]
    [Arguments("application/json")]
    [Arguments("application/json; charset=utf-8")]
    [Arguments("APPLICATION/JSON; charset=\"UTF-8\"")]
    public async Task ReadAsync_Utf8JsonMediaType_Succeeds(string contentType)
    {
        var request = CreateRequest(CreateEnvelope(MinimalDocument));
        request.ContentType = contentType;
        request.Headers.ContentEncoding = "identity";

        RequireEnvelope(await SaveEnvelopeReader.ReadAsync(request, RouteId));
    }

    [Test]
    [Arguments(null)]
    [Arguments("text/json")]
    [Arguments("application/json; charset=utf-16")]
    [Arguments("application/json; charset=\"unterminated")]
    public async Task ReadAsync_UnsupportedMediaType_ReturnsMediaError(string? contentType)
    {
        var request = CreateRequest(CreateEnvelope(MinimalDocument));
        request.ContentType = contentType;

        await AssertErrorAsync(await SaveEnvelopeReader.ReadAsync(request, RouteId),
            415, "unsupported_media_type", "request");
    }

    [Test]
    [Arguments("gzip")]
    [Arguments("identity, gzip")]
    public async Task ReadAsync_UnsupportedContentEncoding_ReturnsEncodingError(string encoding)
    {
        var request = CreateRequest(CreateEnvelope(MinimalDocument));
        request.Headers.ContentEncoding = encoding;

        await AssertErrorAsync(await SaveEnvelopeReader.ReadAsync(request, RouteId),
            415, "unsupported_content_encoding", "request");
    }

    [Test]
    [Arguments("")]
    [Arguments("{")]
    [Arguments("{\"expectedRevision\":01}")]
    public async Task ReadAsync_MalformedJson_ReturnsSafeJsonError(string json)
    {
        await AssertErrorAsync(await ReadAsync(json), 400, "invalid_json", "request");
    }

    [Test]
    public async Task ReadAsync_TrailingJson_ReturnsJsonError()
    {
        await AssertErrorAsync(await ReadAsync(CreateEnvelope(MinimalDocument) + " {}"),
            400, "invalid_json", "request");
    }

    [Test]
    public async Task ReadAsync_InvalidUtf8_ReturnsSafeJsonError()
    {
        var bytes = Encoding.UTF8.GetBytes(CreateEnvelope(MinimalDocument)).Concat(new byte[] { 0xC3, 0x28 }).ToArray();
        var request = CreateRequest(new TrackingStream(bytes));

        await AssertErrorAsync(await SaveEnvelopeReader.ReadAsync(request, RouteId), 400, "invalid_json", "request");
    }

    [Test]
    public async Task ReadAsync_Utf8Bom_ReturnsJsonError()
    {
        var bytes = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes(CreateEnvelope(MinimalDocument))).ToArray();

        await AssertErrorAsync(await SaveEnvelopeReader.ReadAsync(CreateRequest(new TrackingStream(bytes)), RouteId),
            400, "invalid_json", "request");
    }

    [Test]
    public async Task ReadAsync_DeclaredOversize_DoesNotReadBody()
    {
        using var stream = new TrackingStream(Encoding.UTF8.GetBytes(CreateEnvelope(MinimalDocument)));
        var request = CreateRequest(stream);
        request.ContentLength = RequestLimit + 1;

        await AssertErrorAsync(await SaveEnvelopeReader.ReadAsync(request, RouteId), 413, "request_too_large", "request");
        await Assert.That(stream.BytesRead).IsEqualTo(0);
    }

    [Test]
    [Arguments(null)]
    [Arguments(1L)]
    public async Task ReadAsync_ActualOversize_StopsAfterOneOverflowByte(long? declaredLength)
    {
        using var stream = new TrackingStream(new byte[RequestLimit + 4096]);
        var request = CreateRequest(stream);
        request.ContentLength = declaredLength;

        await AssertErrorAsync(await SaveEnvelopeReader.ReadAsync(request, RouteId), 413, "request_too_large", "request");
        await Assert.That(stream.BytesRead).IsEqualTo(RequestLimit + 1);
    }

    [Test]
    public async Task ReadAsync_ExactRequestLimitWithChunkedBody_Succeeds()
    {
        var json = CreateEnvelope(MinimalDocument);
        var bytes = Encoding.UTF8.GetBytes(json + new string(' ', RequestLimit - Encoding.UTF8.GetByteCount(json)));
        using var stream = new TrackingStream(bytes, 113);
        var request = CreateRequest(stream);
        request.Headers.TransferEncoding = "chunked";

        RequireEnvelope(await SaveEnvelopeReader.ReadAsync(request, RouteId));
        await Assert.That(stream.BytesRead).IsEqualTo(RequestLimit);
    }

    [Test]
    [Arguments(0, true)]
    [Arguments(1, false)]
    public async Task ReadAsync_OriginalDocumentByteLimit_CountsInteriorWhitespace(int extraBytes, bool allowed)
    {
        var document = MinimalDocument.Insert(1, new string(' ', DocumentLimit + extraBytes - Encoding.UTF8.GetByteCount(MinimalDocument)));
        var result = await ReadAsync(CreateEnvelope(document));

        if (allowed)
        {
            await Assert.That(RequireEnvelope(result).UnvalidatedDocumentJson).IsEqualTo(document);
        }
        else
        {
            await AssertErrorAsync(result, 413, "document_too_large", "document");
        }
    }

    [Test]
    public async Task ReadAsync_MultibyteDocumentOverBudget_RejectsUtf8BytesDespiteSmallerCharacterCount()
    {
        var prefix = $"{{\"projectId\":\"{ProjectId}\",\"text\":\"";
        const string suffix = "\"}";
        var availableBytes = DocumentLimit - Encoding.UTF8.GetByteCount(prefix + suffix);
        var document = prefix + new string('界', availableBytes / 3) + new string(' ', availableBytes % 3 + 1) + suffix;

        await Assert.That(document.Length < DocumentLimit).IsTrue();
        await Assert.That(Encoding.UTF8.GetByteCount(document)).IsEqualTo(DocumentLimit + 1);
        await AssertErrorAsync(await ReadAsync(CreateEnvelope(document)), 413, "document_too_large", "document");
    }

    [Test]
    public async Task ReadAsync_DeclaredLengthLargerThanShortBody_ReadsActualNonseekableStream()
    {
        using var stream = new TrackingStream(Encoding.UTF8.GetBytes(CreateEnvelope(MinimalDocument)), 3);
        var request = CreateRequest(stream);
        request.ContentLength = RequestLimit;

        RequireEnvelope(await SaveEnvelopeReader.ReadAsync(request, RouteId));
    }

    [Test]
    public async Task ReadAsync_CanceledToken_PropagatesWithoutReading()
    {
        using var stream = new TrackingStream(Encoding.UTF8.GetBytes(CreateEnvelope(MinimalDocument)));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await SaveEnvelopeReader.ReadAsync(CreateRequest(stream), RouteId, cancellation.Token));
        await Assert.That(stream.BytesRead).IsEqualTo(0);
    }

    [Test]
    public async Task ReadAsync_CancellationDuringShortReads_Propagates()
    {
        using var cancellation = new CancellationTokenSource();
        using var stream = new TrackingStream(Encoding.UTF8.GetBytes(CreateEnvelope(MinimalDocument)), 1,
            cancelAfterRead: cancellation);

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await SaveEnvelopeReader.ReadAsync(CreateRequest(stream), RouteId, cancellation.Token));
        await Assert.That(stream.BytesRead).IsEqualTo(1);
    }

    [Test]
    public async Task ReadAsync_StreamFailure_PropagatesIOException()
    {
        using var stream = new TrackingStream([], throwsOnRead: true);

        await Assert.ThrowsAsync<IOException>(async () => await SaveEnvelopeReader.ReadAsync(CreateRequest(stream), RouteId));
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task ReadAsync_SuccessOrFailure_LeavesRequestBodyOpen(bool valid)
    {
        using var stream = new TrackingStream(Encoding.UTF8.GetBytes(valid ? CreateEnvelope(MinimalDocument) : "{"));

        await SaveEnvelopeReader.ReadAsync(CreateRequest(stream), RouteId);

        await Assert.That(stream.IsDisposed).IsFalse();
    }

    private static string CreateEnvelope(string document, string revision = "0") =>
        $$"""{"expectedRevision":{{revision}},"clientMutationId":"{{MutationId}}","document":{{document}}}""";

    private static Task<SaveEnvelopeReadResult> ReadAsync(string json) =>
        SaveEnvelopeReader.ReadAsync(CreateRequest(json), RouteId);

    private static HttpRequest CreateRequest(string json) => CreateRequest(new MemoryStream(Encoding.UTF8.GetBytes(json)));

    private static HttpRequest CreateRequest(Stream body)
    {
        var request = new DefaultHttpContext().Request;
        request.ContentType = "application/json";
        request.Body = body;
        return request;
    }

    private static ParsedSaveEnvelope RequireEnvelope(SaveEnvelopeReadResult result) =>
        result.Envelope ?? throw new InvalidOperationException($"Expected a parsed envelope, received {result.Error?.Code}");

    private static async Task AssertErrorAsync(SaveEnvelopeReadResult result, int status, string code, string path)
    {
        var error = result.Error ?? throw new InvalidOperationException("Expected a boundary error");
        await Assert.That(result.Envelope).IsNull();
        await Assert.That(error.StatusCode).IsEqualTo(status);
        await Assert.That(error.Code).IsEqualTo(code);
        await Assert.That(error.Path).IsEqualTo(path);
    }

    private sealed class TrackingStream(
        byte[] bytes,
        int maxChunk = int.MaxValue,
        bool throwsOnRead = false,
        CancellationTokenSource? cancelAfterRead = null) : Stream
    {
        private int _position;
        public int BytesRead => _position;
        public bool IsDisposed { get; private set; }
        public override bool CanRead => !IsDisposed;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            ObjectDisposedException.ThrowIf(IsDisposed, this);
            if (throwsOnRead)
            {
                throw new IOException("Test stream failure");
            }

            var count = Math.Min(Math.Min(buffer.Length, maxChunk), bytes.Length - _position);
            bytes.AsSpan(_position, count).CopyTo(buffer);
            _position += count;
            cancelAfterRead?.Cancel();
            return count;
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(Read(buffer.Span));
        }

        protected override void Dispose(bool disposing)
        {
            IsDisposed = true;
            base.Dispose(disposing);
        }

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
