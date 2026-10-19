using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Spatia.Server.Hosting;
using Spatia.Server.Projects;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class ProjectHttpResultsTests
{
    private const string PrivateMarker = "http-result-private-document-and-digest";
    private const string TraceId = "project-http-response-test";
    private static readonly Guid PrivateProjectId = Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    [Test]
    [Arguments(ProjectAccessFailure.AuthenticationRequired, 401, "authentication_required")]
    [Arguments(ProjectAccessFailure.PasswordChangeRequired, 403, "password_change_required")]
    [Arguments(ProjectAccessFailure.NotFound, 404, "project_not_found")]
    [Arguments(ProjectAccessFailure.OperationForbidden, 403, "access_denied")]
    [Arguments(ProjectAccessFailure.ProjectReadOnly, 403, "project_read_only")]
    public async Task ProjectHttp_DeniedSaveExposesOnlySafeProblemFields(
        ProjectAccessFailure failure, int status, string code)
    {
        var response = await ExecuteAsync(context =>
            ProjectHttpResults.FromSave(context, ProjectSaveResult.Denied(failure)));

        await AssertProblemAsync(response, status, code);
        await AssertFieldsAsync(response.Json, "type", "title", "status", "code", "traceId");
    }

    [Test]
    [Arguments(ProjectSaveDecision.Conflict, 13L, "revision_conflict")]
    [Arguments(ProjectSaveDecision.RevisionExhausted, Project.MaxRevision, "revision_exhausted")]
    public async Task ProjectHttp_ConflictExposesOnlyTheAuthorizedCurrentRevision(
        ProjectSaveDecision decision, long revision, string code)
    {
        var response = await ExecuteAsync(context =>
            ProjectHttpResults.FromSave(context, ProjectSaveResult.Rejected(decision, revision)));

        await AssertProblemAsync(response, 409, code);
        await AssertFieldsAsync(response.Json, "type", "title", "status", "code", "traceId", "currentRevision");
        await Assert.That(response.Json.GetProperty("currentRevision").GetInt64()).IsEqualTo(revision);
    }

    [Test]
    public async Task ProjectHttp_CommittedSaveReturnsOnlyItsPublicAcknowledgement()
    {
        var acknowledgement = new ProjectSaveAcknowledgement(Guid.NewGuid(), 42, Guid.NewGuid(),
            new DateTimeOffset(2026, 10, 19, 9, 0, 0, TimeSpan.Zero));
        var response = await ExecuteAsync(context =>
            ProjectHttpResults.FromSave(context, ProjectSaveResult.Committed(acknowledgement)));

        await Assert.That(response.Status).IsEqualTo(200);
        await Assert.That(response.ContentType!.StartsWith("application/json", StringComparison.Ordinal)).IsTrue();
        await AssertFieldsAsync(response.Json, "projectId", "revision", "clientMutationId", "savedAt");
        await Assert.That(response.Json.GetProperty("projectId").GetGuid()).IsEqualTo(acknowledgement.ProjectId);
        await Assert.That(response.Json.GetProperty("revision").GetInt64()).IsEqualTo(acknowledgement.Revision);
        await Assert.That(response.Json.GetProperty("clientMutationId").GetGuid()).IsEqualTo(acknowledgement.ClientMutationId);
        await Assert.That(response.Json.GetProperty("savedAt").GetDateTimeOffset()).IsEqualTo(acknowledgement.SavedAt);
        await Assert.That(response.Json.GetProperty("savedAt").GetDateTimeOffset().Offset).IsEqualTo(TimeSpan.Zero);
    }

    [Test]
    public async Task ProjectHttp_InaccessibleIdsShareTheSamePublicNotFoundResponse()
    {
        var first = await ExecuteAsync(context => ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound));
        var second = await ExecuteAsync(context => ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound),
            Guid.NewGuid());

        await AssertProblemAsync(first, 404, "project_not_found");
        await Assert.That(second.Status).IsEqualTo(first.Status);
        await Assert.That(second.Json.GetRawText()).IsEqualTo(first.Json.GetRawText());
        await AssertFieldsAsync(first.Json, "type", "title", "status", "code", "traceId");
    }

    [Test]
    [Arguments(ProjectSaveDecision.WriteRequired, 0L)]
    [Arguments(ProjectSaveDecision.Replay, 0L)]
    [Arguments((ProjectSaveDecision)99, 0L)]
    [Arguments(ProjectSaveDecision.Conflict, -1L)]
    [Arguments(ProjectSaveDecision.Conflict, Project.MaxRevision + 1)]
    public async Task ProjectHttp_IncompleteOrInvalidOutcomeCannotWriteAResponse(ProjectSaveDecision decision, long revision)
    {
        var context = new DefaultHttpContext();
        using var body = new MemoryStream();
        context.Response.Body = body;

        Assert.Throws<InvalidOperationException>(() =>
            ProjectHttpResults.FromSave(context, ProjectSaveResult.Rejected(decision, revision)));

        await Assert.That(body.Length).IsEqualTo(0L);
        await Assert.That(context.Response.ContentType).IsNull();
    }

    [Test]
    public async Task ProjectHttp_UnknownAccessFailureCannotWriteAResponse()
    {
        var context = new DefaultHttpContext();
        using var body = new MemoryStream();
        context.Response.Body = body;

        Assert.Throws<ArgumentOutOfRangeException>(() => ProjectHttpResults.FromAccessFailure(context, (ProjectAccessFailure)99));

        await Assert.That(body.Length).IsEqualTo(0L);
        await Assert.That(context.Response.ContentType).IsNull();
    }

    [Test]
    public async Task ProjectHttp_SharedProblemFactoryKeepsItsExistingContractWithoutRevision()
    {
        var response = await ExecuteAsync(context => ApiProblems.Create(context, 400, "invalid_request", "The request is invalid"));

        await AssertProblemAsync(response, 400, "invalid_request");
        await AssertFieldsAsync(response.Json, "type", "title", "status", "code", "traceId");
    }

    private static async Task<(int Status, string? ContentType, JsonElement Json)> ExecuteAsync(
        Func<HttpContext, IResult> create, Guid? projectId = null)
    {
        using var logs = new CapturedLogProvider();
        var services = new ServiceCollection();
        services.AddLogging(builder => builder.AddProvider(logs));
        services.AddProblemDetails();
        using var provider = services.BuildServiceProvider();
        var context = new DefaultHttpContext { RequestServices = provider, TraceIdentifier = TraceId };
        var routeId = projectId ?? PrivateProjectId;
        context.Request.Path = "/api/projects/" + routeId;
        context.Request.QueryString = new QueryString("?private=" + PrivateMarker);
        context.Request.Headers.Cookie = "private=" + PrivateMarker;
        using var requestBody = new MemoryStream(Encoding.UTF8.GetBytes(PrivateMarker));
        context.Request.Body = requestBody;
        using var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await create(context).ExecuteAsync(context);

        await Assert.That(context.Response.Headers.CacheControl.ToString()).IsEqualTo("no-store");
        await Assert.That(context.Response.Headers.Location.Count).IsEqualTo(0);
        await Assert.That(context.Response.Headers.SetCookie.Count).IsEqualTo(0);
        var body = Encoding.UTF8.GetString(responseBody.ToArray());
        await Assert.That(body.Contains(PrivateMarker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(body.Contains(routeId.ToString(), StringComparison.Ordinal)).IsFalse();
        await Assert.That(logs.Messages.Contains(PrivateMarker, StringComparison.Ordinal)).IsFalse();
        await Assert.That(logs.Messages.Contains(routeId.ToString(), StringComparison.Ordinal)).IsFalse();
        using var json = JsonDocument.Parse(body);
        return (context.Response.StatusCode, context.Response.ContentType, json.RootElement.Clone());
    }

    private static async Task AssertProblemAsync((int Status, string? ContentType, JsonElement Json) response,
        int status, string code)
    {
        await Assert.That(response.Status).IsEqualTo(status);
        await Assert.That(response.ContentType!.StartsWith("application/problem+json", StringComparison.Ordinal)).IsTrue();
        await Assert.That(response.Json.GetProperty("status").GetInt32()).IsEqualTo(status);
        await Assert.That(response.Json.GetProperty("code").GetString()).IsEqualTo(code);
        await Assert.That(response.Json.GetProperty("traceId").GetString()).IsEqualTo(Activity.Current?.Id ?? TraceId);
    }

    private static async Task AssertFieldsAsync(JsonElement json, params string[] expected) =>
        await Assert.That(string.Join(',', json.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal)))
            .IsEqualTo(string.Join(',', expected.Order(StringComparer.Ordinal)));
}
