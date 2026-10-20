using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

internal static class AuthTestRequests
{
    public const string CurrentPassword = "Synthetic-long-password1!";
    public const string NewPassword = "Changed synthetic password 2!";

    public static async Task<string> UserNameAsync(HttpsApplicationFixture fixture, Guid id)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.Where(user => user.Id == id)
            .Select(user => user.UserName!).SingleAsync();
    }

    public static async Task<HttpResponseMessage> PostAsync(HttpsApplicationFixture fixture, string path,
        object? body, HttpClient? client = null, string? token = null)
    {
        client ??= fixture.Client;
        using var request = new HttpRequestMessage(HttpMethod.Post, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }
        request.Headers.Add("X-CSRF-TOKEN", token ?? await fixture.GetCsrfAsync(client));
        return await client.SendAsync(request);
    }

    public static async Task AssertProblemAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        await Assert.That(response.StatusCode).IsEqualTo(status);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        await Assert.That(json.RootElement.GetProperty("code").GetString()).IsEqualTo(code);
        await Assert.That(response.Headers.Location is null).IsTrue();
    }

    public static async Task AssertSafeAsync(HttpsApplicationFixture fixture, HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        foreach (var secret in new[] { CurrentPassword, NewPassword, HttpsApplicationFixture.SecretSentinel })
        {
            await Assert.That(text.Contains(secret, StringComparison.Ordinal)).IsFalse();
            await Assert.That(fixture.Logs.Messages.Contains(secret, StringComparison.Ordinal)).IsFalse();
        }
        await Assert.That(text.Contains("passwordHash", StringComparison.OrdinalIgnoreCase)
            || text.Contains("securityStamp", StringComparison.OrdinalIgnoreCase)).IsFalse();
    }
}
