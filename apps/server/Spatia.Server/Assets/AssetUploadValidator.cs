using System.Diagnostics;
using System.Text.Json;

namespace Spatia.Server.Assets;

/// <summary>Runs the existing delivery validator in a bounded child process without user-controlled arguments</summary>
public sealed class AssetUploadValidator(IConfiguration configuration)
{
    private string Script => configuration["AssetIntake:ValidatorScript"]
        ?? Path.Combine(AppContext.BaseDirectory, "tools", "validate-intake.mjs");

    // Let the list endpoint disable submission when the packaged validation script is missing
    public bool IsAvailable => Path.IsPathFullyQualified(Script) && File.Exists(Script);

    public async Task<(bool Valid, string[] Messages)?> ValidateAsync(byte[] bytes, CancellationToken cancellationToken)
    {

        // Use the packaged validator by default; missing tooling never becomes implicit approval
        var script = Script;
        if (string.IsNullOrWhiteSpace(script) || !Path.IsPathFullyQualified(script) || !File.Exists(script))
        {
            return null;
        }

        // Launch only the configured executable and fixed script; uploaded names never become arguments
        // Keep the validator out of the API process so malformed model parsing has its own memory ceiling
        var start = new ProcessStartInfo(configuration["AssetIntake:NodeExecutable"] ?? "node")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("--max-old-space-size=256");
        start.ArgumentList.Add(script);
        using var process = new Process { StartInfo = start };

        // Share request cancellation with a hard time limit so abandoned uploads cannot leave work running
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var started = false;
        try
        {
            process.Start();
            started = true;

            // Read both pipes while writing input to avoid a child-process pipe deadlock
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.StandardInput.BaseStream.WriteAsync(bytes, timeout.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            var json = await output;
            await errors;

            // Require the structured result and exit code to agree before accepting the validator response
            // An execution failure stays unavailable rather than being reported as invalid user content
            using var result = JsonDocument.Parse(json);
            if (process.ExitCode is not (0 or 1))
            {
                return null;
            }
            var valid = result.RootElement.GetProperty("valid").GetBoolean();
            if (valid != (process.ExitCode == 0))
            {
                return null;
            }

            // Keep technical warnings visible to the reviewer without misclassifying them as invalid bytes
            var messages = result.RootElement.GetProperty("messages").EnumerateArray()
                .Select(message => message.GetString() ?? "Asset validation reported an issue").Take(20).ToArray();
            return (valid, messages);
        }
        catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or IOException or JsonException or OperationCanceledException or InvalidOperationException)
        {

            // Terminate the entire child tree before returning; a cancelled caller must still observe cancellation
            if (started && !process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }
}
