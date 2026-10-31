using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectRequestBoundaryTests
{
    private const string ProjectId = "11111111-1111-4111-8111-111111111111";
    private const string BodyMarker = "private-envelope-body-not-for-logs";
    private const string SavePath = "/api/projects/" + ProjectId;
    private const int RequestLimit = 6 * 1024 * 1024;
    private const int DocumentLimit = 5 * 1024 * 1024;
    private static readonly string Document = ProjectTestDocuments.Create(Guid.Parse(ProjectId), BodyMarker);

    // Kestrel counts the single six-digit chunk's 15 framing bytes against its transport limit
    [Test]
    [Arguments(RequestLimit, false, HttpStatusCode.OK)]
    [Arguments(RequestLimit - 15, true, HttpStatusCode.OK)]
    [Arguments(RequestLimit + 1, false, HttpStatusCode.RequestEntityTooLarge)]
    [Arguments(RequestLimit - 14, true, HttpStatusCode.RequestEntityTooLarge)]
    public async Task RequestLimits_EndpointMetadataAndReaderShareTheSixMiBBoundary(
        int bytes, bool chunked, HttpStatusCode status)
    {
        await using var fixture = await CreateFixtureAsync();
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(bytes)),
            await fixture.GetCsrfAsync(), chunked);
        // Receive a declared-length rejection before starting an upload the server will close
        request.Headers.ExpectContinue = !chunked;

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, status,
            status == HttpStatusCode.RequestEntityTooLarge ? "request_too_large" : null);
        await AssertStoredRevisionAsync(fixture, status == HttpStatusCode.OK ? 1 : 0);
    }

    [Test]
    [Arguments(0, HttpStatusCode.OK)]
    [Arguments(1, HttpStatusCode.RequestEntityTooLarge)]
    public async Task RequestLimits_DocumentBudgetRemainsFiveMiBInsideTheLargerEnvelope(int overflow, HttpStatusCode status)
    {
        await using var fixture = await CreateFixtureAsync();
        var document = Document.Insert(1, new string(' ', DocumentLimit + overflow - Document.Length));
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(document)), await fixture.GetCsrfAsync());

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, status,
            status == HttpStatusCode.RequestEntityTooLarge ? "document_too_large" : null);
        await AssertStoredRevisionAsync(fixture, status == HttpStatusCode.OK ? 1 : 0);
    }

    [Test]
    public async Task RequestLimits_CompressedOversizedInputIsRejectedWithoutDecompression()
    {
        await using var fixture = await CreateFixtureAsync();
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
        await AssertStoredRevisionAsync(fixture, 0);
    }

    [Test]
    [Arguments("anonymous", HttpStatusCode.Unauthorized, "authentication_required")]
    [Arguments("forced", HttpStatusCode.Forbidden, "access_denied")]
    [Arguments("csrf", HttpStatusCode.BadRequest, "csrf_invalid")]
    public async Task RequestLimits_LargerEndpointBudgetDoesNotBypassSessionOrCsrf(
        string scenario, HttpStatusCode status, string code)
    {
        await using var fixture = await CreateFixtureAsync(scenario);
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(32 * 1024)),
            scenario == "csrf" ? null : await fixture.GetCsrfAsync());

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, status, code);
        await AssertStoredRevisionAsync(fixture, 0);
    }

    [Test]
    [Arguments("POST", "/api/auth/login")]
    [Arguments("POST", SavePath)]
    [Arguments("PUT", "/api/projects/not-a-project-id")]
    public async Task RequestLimits_AccountWrongMethodAndUnmappedPathKeepTheSixteenKiBDefault(string method, string path)
    {
        await using var fixture = await CreateFixtureAsync();
        using var request = CreateRequest(Encoding.UTF8.GetBytes(Envelope(Document).PadRight(16 * 1024 + 1)),
            await fixture.GetCsrfAsync());
        request.Method = new HttpMethod(method);
        request.RequestUri = new Uri(path, UriKind.Relative);

        using var response = await fixture.Client.SendAsync(request);

        await AssertResponseAsync(fixture, response, HttpStatusCode.RequestEntityTooLarge, "request_too_large");
        await AssertStoredRevisionAsync(fixture, 0);
    }

    private static async Task<HttpsApplicationFixture> CreateFixtureAsync(string scenario = "full")
    {
        var fixture = await HttpsApplicationFixture.CreateAsync(environmentName: "Development");
        try
        {
            var actor = await fixture.CreateAccountAsync(forced: scenario == "forced");
            await using var scope = fixture.Database.Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var id = Guid.Parse(ProjectId);
            database.Projects.Add(new Project
            {
                Id = id,
                OrganizationId = await database.Organizations.Select(row => row.Id).SingleAsync(),
                SchemaVersion = 1,
                DocumentJson = Document,
                UpdatedAt = DateTimeOffset.UnixEpoch,
            });
            database.ProjectAssignments.Add(new ProjectAssignment { ProjectId = id, UserId = actor, CanEdit = true });
            await database.SaveChangesAsync();
            if (scenario != "anonymous")
            {
                await fixture.SignInAsync(actor);
            }
            return fixture;
        }
        catch
        {
            await fixture.DisposeAsync();
            throw;
        }
    }

    private static async Task AssertStoredRevisionAsync(HttpsApplicationFixture fixture, long expected)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var project = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Projects.SingleAsync();
        await Assert.That(project.Revision).IsEqualTo(expected);
        using var stored = JsonDocument.Parse(project.DocumentJson);
        await Assert.That(stored.RootElement.GetProperty("title").GetString()).IsEqualTo(BodyMarker);
    }

    private static string Envelope(string document) =>
        $$"""{"expectedRevision":0,"clientMutationId":"44444444-4444-4444-8444-444444444444","document":{{document}}}""";

    private static HttpRequestMessage CreateRequest(byte[] body, string? token, bool chunked = false)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, SavePath)
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
