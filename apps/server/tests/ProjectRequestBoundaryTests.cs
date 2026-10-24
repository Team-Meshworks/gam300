using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Spatia.Server.Hosting;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectRequestBoundaryTests
{
    private const string ProjectId = "11111111-1111-4111-8111-111111111111";
    private const string BodyMarker = "private-envelope-body-not-for-logs";
    private const string ProbePath = "/_test/project-envelope/" + ProjectId;
    private const int RequestLimit = 6 * 1024 * 1024;
    private const int DocumentLimit = 5 * 1024 * 1024;
    private static readonly string Document = $$"""{"projectId":"{{ProjectId}}","title":"{{BodyMarker}}"}""";

    // Kestrel counts the single six-digit chunk's 15 framing bytes against its transport limit
    [Test]
    [Arguments(RequestLimit, false, HttpStatusCode.NoContent)]
    [Arguments(RequestLimit - 15, true, HttpStatusCode.NoContent)]
    [Arguments(RequestLimit + 1, false, HttpStatusCode.RequestEntityTooLarge)]
    [Arguments(RequestLimit - 14, true, HttpStatusCode.RequestEntityTooLarge)]
    public async Task RequestLimits_EndpointMetadataAndReaderShareTheSixMiBBoundary(
        int bytes, bool chunked, HttpStatusCode status)
    {
        var calls = 0;
        await using var fixture = await CreateFixtureAsync(() => calls++);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(bytes)),
            await fixture.GetCsrfAsync(), chunked);
        // Receive a declared-length rejection before starting an upload the server will close
        request.Headers.ExpectContinue = !chunked;

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, status,
            status == HttpStatusCode.RequestEntityTooLarge ? "request_too_large" : null);
        await Assert.That(calls).IsEqualTo(bytes > RequestLimit ? 0 : 1);
    }

    [Test]
    [Arguments(0, HttpStatusCode.NoContent)]
    [Arguments(1, HttpStatusCode.RequestEntityTooLarge)]
    public async Task RequestLimits_DocumentBudgetRemainsFiveMiBInsideTheLargerEnvelope(int overflow, HttpStatusCode status)
    {
        var calls = 0;
        await using var fixture = await CreateFixtureAsync(() => calls++);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        var document = Document.Insert(1, new string(' ', DocumentLimit + overflow - Document.Length));
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(document)), await fixture.GetCsrfAsync());

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, status,
            status == HttpStatusCode.RequestEntityTooLarge ? "document_too_large" : null);
        await Assert.That(calls).IsEqualTo(1);
    }

    [Test]
    public async Task RequestLimits_CompressedOversizedInputIsRejectedWithoutDecompression()
    {
        var calls = 0;
        await using var fixture = await CreateFixtureAsync(() => calls++);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var compressed = new MemoryStream();
        using (var gzip = new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(RequestLimit + 1)));
        }
        await Assert.That(compressed.Length < RequestLimit).IsTrue();
        using var request = CreateRequest(compressed.ToArray(), await fixture.GetCsrfAsync());
        request.Content!.Headers.ContentEncoding.Add("gzip");

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, HttpStatusCode.UnsupportedMediaType, "unsupported_content_encoding");
        await Assert.That(calls).IsEqualTo(1);
    }

    [Test]
    [Arguments("anonymous", HttpStatusCode.Unauthorized, "authentication_required")]
    [Arguments("forced", HttpStatusCode.Forbidden, "access_denied")]
    [Arguments("csrf", HttpStatusCode.BadRequest, "csrf_invalid")]
    public async Task RequestLimits_LargerEndpointBudgetDoesNotBypassSessionOrCsrf(
        string scenario, HttpStatusCode status, string code)
    {
        var calls = 0;
        await using var fixture = await CreateFixtureAsync(() => calls++);
        if (scenario != "anonymous")
        {
            await fixture.SignInAsync(await fixture.CreateAccountAsync(forced: scenario == "forced"));
        }
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(32 * 1024)),
            scenario == "csrf" ? null : await fixture.GetCsrfAsync());

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, status, code);
        await Assert.That(calls).IsEqualTo(0);
    }

    [Test]
    [Arguments("POST", "/api/auth/login")]
    [Arguments("POST", ProbePath)]
    [Arguments("PUT", "/api/projects/" + ProjectId)]
    public async Task RequestLimits_AccountWrongMethodAndUnmappedProjectKeepTheSixteenKiBDefault(string method, string path)
    {
        var calls = 0;
        await using var fixture = await CreateFixtureAsync(() => calls++);
        await fixture.SignInAsync(await fixture.CreateAccountAsync());
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(16 * 1024 + 1)),
            await fixture.GetCsrfAsync());
        request.Method = new HttpMethod(method);
        request.RequestUri = new Uri(path, UriKind.Relative);

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, HttpStatusCode.RequestEntityTooLarge, "request_too_large");
        await Assert.That(calls).IsEqualTo(0);
    }

    private static Task<HttpsApplicationFixture> CreateFixtureAsync(Action entered) =>
        HttpsApplicationFixture.CreateAsync(map: app =>
            app.MapPut("/_test/project-envelope/{id:guid}", async (HttpContext context, Guid id) =>
            {
                entered();
                // This probe parses the envelope only; SCRUM-50 acceptance and saving remain unwired
                var result = await SaveEnvelopeReader.ReadAsync(context.Request, id, context.RequestAborted);
                return result.Error is { } error
                    ? ApiProblems.Create(context, error.StatusCode, error.Code, error.Message)
                    : Results.NoContent();
            }).WithMetadata(new RequestSizeLimitAttribute(SaveEnvelopeReader.MaxRequestBytes)));

    private static string Envelope(string document) =>
        $$"""{"expectedRevision":0,"clientMutationId":"44444444-4444-4444-8444-444444444444","document":{{document}}}""";

    private static HttpRequestMessage CreateRequest(byte[] body, string? token, bool chunked = false)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, ProbePath)
        {
            Version = HttpVersion.Version11,
            VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            Content = new ByteArrayContent(body),
        };
        request.Content.Headers.ContentType = new("application/json");
        if (token is not null)
        {
            request.Headers.Add("X-CSRF-TOKEN", token);
        }
        if (chunked)
        {
            request.Headers.TransferEncodingChunked = true;
        }
        return request;
    }

    private static async Task AssertResponseAsync(HttpsApplicationFixture fixture, HttpResponseMessage response,
        HttpStatusCode status, string? code)
    {
        await Assert.That(response.StatusCode).IsEqualTo(status);
        await Assert.That(response.Headers.CacheControl?.NoStore == true).IsTrue();
        await AuthTestRequests.AssertSafeAsync(fixture, response);
        await Assert.That((await response.Content.ReadAsStringAsync()).Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(BodyMarker, StringComparison.Ordinal)).IsFalse();
        if (code is not null)
        {
            await AuthTestRequests.AssertProblemAsync(response, status, code);
            await Assert.That(response.Content.Headers.ContentType?.MediaType).IsEqualTo("application/problem+json");
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            await Assert.That(string.IsNullOrWhiteSpace(json.RootElement.GetProperty("traceId").GetString())).IsFalse();
        }
    }
}
