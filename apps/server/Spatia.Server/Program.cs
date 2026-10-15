using Spatia.Server.Accounts;
using Spatia.Server.Hosting;

namespace Spatia.Server;

public static class Program
{
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
