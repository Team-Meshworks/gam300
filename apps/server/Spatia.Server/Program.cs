using Spatia.Server.Hosting;

namespace Spatia.Server;

public static class Program
{
    public static Task Main(string[] args) =>
        SpatiaApplication.Build(WebApplication.CreateBuilder(args)).RunAsync();
}
