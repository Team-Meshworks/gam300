using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Spatia.Server.Hosting;
using HttpJsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Spatia.Server.Accounts;

public static class BootstrapAdministratorCommand
{
    public static async Task<int> RunAsync(
        WebApplicationBuilder builder,
        Stream input,
        TextWriter output,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await using var app = SpatiaApplication.Build(builder);
            var buffer = new byte[16385];
            var length = await input.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, cancellationToken);
            if (length > 16384)
            {
                await output.WriteLineAsync("Invalid bootstrap input.");
                return 2;
            }

            new UTF8Encoding(false, true).GetCharCount(buffer, 0, length);
            var options = app.Services.GetRequiredService<IOptions<HttpJsonOptions>>().Value.SerializerOptions;
            var request = JsonSerializer.Deserialize<BootstrapAdministratorRequest>(buffer.AsSpan(0, length), options);
            if (request is null)
            {
                await output.WriteLineAsync("Invalid bootstrap input.");
                return 2;
            }

            await using var scope = app.Services.CreateAsyncScope();
            var result = await scope.ServiceProvider.GetRequiredService<AccountAdministrationService>()
                .BootstrapAdministratorAsync(request, cancellationToken);
            if (result.Succeeded)
            {
                await output.WriteLineAsync("Administrator created; a first-sign-in password change is required.");
                return 0;
            }
            if (result.Errors.Any(error => error.Code == "BootstrapAlreadyExists"))
            {
                await output.WriteLineAsync("An administrator already exists; bootstrap refused.");
                return 3;
            }

            await output.WriteLineAsync("Invalid bootstrap input or unavailable username.");
            return 2;
        }
        catch (Exception exception) when (exception is JsonException or DecoderFallbackException)
        {
            await output.WriteLineAsync("Invalid bootstrap input.");
            return 2;
        }
        catch (OperationCanceledException)
        {
            await output.WriteLineAsync("Bootstrap canceled; verify database state before retrying.");
            return 1;
        }
        catch (Exception)
        {
            await output.WriteLineAsync("Bootstrap did not confirm completion; verify private setup and database state before retrying.");
            return 1;
        }
    }
}
