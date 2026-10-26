using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Spatia.Server.Hosting;
using HttpJsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Spatia.Server.Accounts;

/// <summary>
/// Creates the first administrator from private JSON input without starting the HTTP server
/// </summary>
public static class BootstrapAdministratorCommand
{
    /// <summary>
    /// Reads bounded UTF-8 credentials, attempts administrator creation and writes a credential-free status
    /// </summary>
    /// <param name="builder">The application builder containing the required server configuration</param>
    /// <param name="input">The private JSON input stream, which remains open</param>
    /// <param name="output">The status writer, which remains open</param>
    /// <param name="cancellationToken">The token used to cancel input reading and database work</param>
    /// <returns>
    /// Exit code 0 on success, 1 on cancellation or an unconfirmed failure, 2 on invalid input or rejected
    /// account creation, or 3 when an administrator already exists
    /// </returns>
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
