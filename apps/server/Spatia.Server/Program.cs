using Spatia.Server.Accounts;
using Spatia.Server.Hosting;

namespace Spatia.Server;

/// <summary>
/// Provides the server and private administrator bootstrap entry point
/// </summary>
public static class Program
{
    /// <summary>
    /// Runs the private bootstrap command when selected, or starts the configured HTTP application
    /// </summary>
    /// <param name="args">
    /// Host arguments, or only <c>bootstrap-admin</c> with credentials redirected through standard input
    /// </param>
    /// <returns>
    /// Exit code 0 on normal shutdown or bootstrap success, 1 on an unconfirmed bootstrap failure,
    /// 2 on invalid bootstrap invocation or input, or 3 when an administrator already exists
    /// </returns>
    public static async Task<int> Main(string[] args)
    {
        if (args.FirstOrDefault() == "bootstrap-admin")
        {
            if (args.Length != 1 || !Console.IsInputRedirected)
            {
                await Console.Error.WriteLineAsync("Bootstrap requires redirected private JSON input and no credential arguments.");
                return 2;
            }

            try
            {
                return await BootstrapAdministratorCommand.RunAsync(
                    WebApplication.CreateBuilder([]), Console.OpenStandardInput(), Console.Out);
            }
            catch (Exception)
            {
                await Console.Error.WriteLineAsync("Bootstrap did not confirm completion; verify private setup and database state before retrying.");
                return 1;
            }
        }

        await SpatiaApplication.Build(WebApplication.CreateBuilder(args)).RunAsync();
        return 0;
    }
}
