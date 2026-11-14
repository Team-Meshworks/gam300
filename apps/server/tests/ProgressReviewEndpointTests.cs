using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using static Spatia.Server.Tests.ReviewSubmissionEndpointTests;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(ProgressReviewEndpointTests))]
public sealed class ProgressReviewEndpointTests
{
    [Test]
    public async Task UnsubmittedProject_EducatorCommentIsPrivateAndIdempotent()
    {
        await using var fixture = await CreateFixtureAsync(new FixtureAssets());
        var data = await SeedAsync(fixture, false);
        using var educator = fixture.CreateClient();
        await fixture.SignInAsync(data.Educator, educator);
        var id = Guid.NewGuid();
        var path = $"/api/v1/projects/{data.ProjectId:D}/progress-reviews";
        async Task<HttpResponseMessage> WriteAsync(HttpClient client, Guid reviewId, string feedback, long revision = 0)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path)
            { Content = JsonContent.Create(new { reviewId, expectedRevision = revision, feedback }) };
            request.Headers.Add("X-CSRF-TOKEN", await fixture.GetCsrfAsync(client));
            return await client.SendAsync(request);
        }
        using (var created = await WriteAsync(educator, id, "Please add a map"))
        { await Assert.That(created.StatusCode).IsEqualTo(HttpStatusCode.Created); }
        using (var replay = await WriteAsync(educator, id, "Please add a map"))
        { await Assert.That(replay.StatusCode).IsEqualTo(HttpStatusCode.OK); }
        using (var conflict = await WriteAsync(educator, id, "Changed"))
        { await Assert.That(conflict.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        using (var denied = await WriteAsync(fixture.Client, Guid.NewGuid(), "Student cannot write"))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.Forbidden); }
        using (var response = await fixture.Client.GetAsync(path))
        {
            await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
            await Assert.That(response.Headers.CacheControl?.NoStore).IsTrue();
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            await Assert.That(body.GetProperty("items").GetArrayLength()).IsEqualTo(1);
            await Assert.That(body.GetProperty("items")[0].GetProperty("feedback").GetString()).IsEqualTo("Please add a map");
        }
        using var other = fixture.CreateClient();
        await fixture.SignInAsync(data.OtherStudent, other);
        using (var denied = await other.GetAsync(path))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        using (var stale = await WriteAsync(educator, Guid.NewGuid(), "Stale", 1))
        { await Assert.That(stale.StatusCode).IsEqualTo(HttpStatusCode.Conflict); }
        using (var empty = await WriteAsync(educator, Guid.NewGuid(), "   "))
        { await Assert.That(empty.StatusCode).IsEqualTo(HttpStatusCode.BadRequest); }
        var outsider = await fixture.CreateAccountAsync(ApplicationRoles.Educator);
        using var outsiderClient = fixture.CreateClient();
        await fixture.SignInAsync(outsider, outsiderClient);
        using (var denied = await WriteAsync(outsiderClient, Guid.NewGuid(), "Not allowed"))
        { await Assert.That(denied.StatusCode).IsEqualTo(HttpStatusCode.NotFound); }
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await Assert.That(await database.ReviewSubmissions.CountAsync()).IsEqualTo(0);
            await Assert.That(await database.ReviewDecisions.CountAsync()).IsEqualTo(0);
        }
        await fixture.App.StopAsync();
        await using var restarted = await fixture.CreateSiblingAsync(_ => { });
        await restarted.SignInAsync(data.Student);
        using var persisted = await restarted.Client.GetAsync(path);
        await Assert.That(persisted.StatusCode).IsEqualTo(HttpStatusCode.OK);
        var result = await persisted.Content.ReadFromJsonAsync<JsonElement>();
        await Assert.That(result.GetProperty("items")[0].GetProperty("feedback").GetString()).IsEqualTo("Please add a map");
        await using (var scope = restarted.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await database.ClassroomMembers.Where(row => row.ClassroomId == data.ClassroomId && row.UserId == data.Student)
                .ExecuteUpdateAsync(update => update.SetProperty(row => row.IsActive, false));
        }
        using var removed = await restarted.Client.GetAsync(path);
        await Assert.That(removed.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
    }
}
