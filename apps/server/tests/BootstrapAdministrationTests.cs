using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class BootstrapAdministrationTests
{
    private const string Password = "Private synthetic bootstrap password!";

    [Test]
    public async Task Bootstrap_ActualProcess_CreatesNewForcedGlobalAdministrator_ThenRefusesInactiveExistingAdmin()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var first = await RunCliAsync(fixture, JsonSerializer.SerializeToUtf8Bytes(new { userName = "operator-admin", initialPassword = Password }));
        await Assert.That(first.ExitCode).IsEqualTo(0);
        await Assert.That(first.Output.Contains(Password, StringComparison.Ordinal)).IsFalse();
        string hash;
        string stamp;
        await using (var scope = fixture.App.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync();
            await Assert.That(user.UserName).IsEqualTo("operator-admin");
            await Assert.That(user.IsActive && user.MustChangePassword && user.LockoutEnabled).IsTrue();
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            await Assert.That(await manager.CheckPasswordAsync(user, Password)).IsTrue();
            await Assert.That((await manager.GetRolesAsync(user)).SequenceEqual([ApplicationRoles.Administrator])).IsTrue();
            await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(0);
            user.IsActive = false;
            await database.SaveChangesAsync();
            hash = user.PasswordHash!;
            stamp = user.SecurityStamp!;
        }
        var refused = await RunCliAsync(fixture, JsonSerializer.SerializeToUtf8Bytes(new { userName = "another-admin", initialPassword = "Never overwrite existing credentials!" }));
        await Assert.That(refused.ExitCode).IsEqualTo(3);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync();
            await Assert.That(user.PasswordHash == hash && user.SecurityStamp == stamp).IsTrue();
            await Assert.That(user.IsActive).IsFalse();
            await Assert.That(user.MustChangePassword).IsTrue();
        }
        using var noAutomaticSignIn = await fixture.Client.GetAsync("/_test/admin");
        await Assert.That(noAutomaticSignIn.StatusCode).IsEqualTo(System.Net.HttpStatusCode.Unauthorized);
    }

    [Test]
    [Arguments("{}")]
    [Arguments("null")]
    [Arguments("[]")]
    [Arguments("{\"userName\":null,\"initialPassword\":\"valid synthetic password\"}")]
    [Arguments("{\"UserName\":\"synthetic\",\"initialPassword\":\"valid synthetic password\"}")]
    [Arguments("{\"userName\":\"synthetic\",\"initialPassword\":\"valid synthetic password\",\"extra\":true}")]
    [Arguments("{\"userName\":\"a\",\"userName\":\"b\",\"initialPassword\":\"valid synthetic password\"}")]
    [Arguments("{\"userName\":\"a\",\"user\\u004eame\":\"b\",\"initialPassword\":\"valid synthetic password\"}")]
    [Arguments("{\"userName\":\"\\uD800\",\"initialPassword\":\"valid synthetic password\"}")]
    [Arguments("{\"\\uD800\":\"a\",\"initialPassword\":\"valid synthetic password\"}")]
    public async Task Bootstrap_StrictJsonRejectsInvalidOrAmbiguousInput_WithoutCreatingAccounts(string json)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var result = await RunCliAsync(fixture, Encoding.UTF8.GetBytes(json));
        await Assert.That(result.ExitCode).IsEqualTo(2);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.CountAsync()).IsEqualTo(0);
        await Assert.That(result.Output.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
    }

    [Test]
    [Arguments(16384, true)]
    [Arguments(16385, false)]
    public async Task Bootstrap_RedirectedInput_EnforcesByteCeilingBeforeDeserialization(int bytes, bool accepted)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var json = JsonSerializer.Serialize(new { userName = "bounded-operator", initialPassword = Password });
        var payload = Encoding.UTF8.GetBytes(json.PadRight(bytes));
        await Assert.That(payload.Length).IsEqualTo(bytes);
        var result = await RunCliAsync(fixture, payload);
        await Assert.That(result.ExitCode).IsEqualTo(accepted ? 0 : 2);
    }

    [Test]
    public async Task Bootstrap_InvalidRawUtf8_IsInvalidInputWithoutCreation()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var result = await RunCliAsync(fixture, [123, 34, 0xC3, 0x28, 34, 58, 34, 97, 34, 125]);
        await Assert.That(result.ExitCode).IsEqualTo(2);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Bootstrap_CollisionDoesNotPromoteOrModifyOrdinaryAccount()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var id = await fixture.CreateAccountAsync();
        string name;
        string stamp;
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var user = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.SingleAsync();
            name = user.UserName!;
            stamp = user.SecurityStamp!;
        }
        var result = await RunCliAsync(fixture, JsonSerializer.SerializeToUtf8Bytes(new { userName = name.ToUpperInvariant(), initialPassword = Password }));
        await Assert.That(result.ExitCode).IsEqualTo(2);
        await using (var scope = fixture.Database.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var user = await database.Users.SingleAsync();
            await Assert.That(user.SecurityStamp == stamp).IsTrue();
            await Assert.That(await database.UserRoles.Where(role => role.UserId == id).Select(role => role.RoleId).SingleAsync())
                .IsEqualTo(ApplicationRoles.CreatorId);
            await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(1);
        }
    }

    [Test]
    public async Task Bootstrap_SeparateProcessesWaitOnDatabaseLock_ExactlyOneAdministratorCommits()
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var held = await database.Database.BeginTransactionAsync();
        await database.Database.ExecuteSqlRawAsync("LOCK TABLE \"AspNetUserRoles\" IN SHARE ROW EXCLUSIVE MODE");
        var applicationName = "Spatia.BootRace." + fixture.Database.SchemaName;
        var first = RunCliAsync(fixture, JsonSerializer.SerializeToUtf8Bytes(new { userName = "race-admin-a", initialPassword = Password }), applicationName);
        var second = RunCliAsync(fixture, JsonSerializer.SerializeToUtf8Bytes(new { userName = "race-admin-b", initialPassword = Password }), applicationName);
        try
        {
            await using var observerScope = fixture.Database.Services.CreateAsyncScope();
            var observer = (NpgsqlConnection)observerScope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetDbConnection();
            await observer.OpenAsync();
            await using var blocked = new NpgsqlCommand("SELECT count(*) FROM pg_stat_activity WHERE application_name = @name AND wait_event_type = 'Lock'", observer);
            blocked.Parameters.AddWithValue("name", applicationName);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while ((long)(await blocked.ExecuteScalarAsync(timeout.Token) ?? 0L) < 2)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(10), timeout.Token);
            }
        }
        finally
        {
            await held.RollbackAsync();
            await Task.WhenAll(first, second);
        }
        var results = await Task.WhenAll(first, second);
        await Assert.That(results.Count(result => result.ExitCode == 0)).IsEqualTo(1);
        await Assert.That(results.Count(result => result.ExitCode == 3)).IsEqualTo(1);
        database.ChangeTracker.Clear();
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.UserRoles.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.OrganizationMemberships.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task Bootstrap_CommandFailureOrCancellationAtCommit_IsSafeAndRollsBack(bool canceled)
    {
        var interceptor = new AdministrationCommitInterceptor();
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var connection = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetConnectionString();
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Spatia"] = connection,
            ["DataProtection:KeyDirectory"] = fixture.KeyDirectory,
            ["AllowedHosts"] = "127.0.0.1;localhost",
        });
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(fixture.Logs);
        builder.Services.AddDbContext<ApplicationDbContext>(options => options.AddInterceptors(interceptor));
        using var cancellation = new CancellationTokenSource();
        interceptor.Arm(canceled ? cancellation : null);
        await using var input = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(new { userName = "rollback-operator", initialPassword = Password }));
        using var output = new StringWriter();
        var exit = await BootstrapAdministratorCommand.RunAsync(builder, input, output, cancellation.Token);
        await Assert.That(exit).IsEqualTo(1);
        await Assert.That(output.ToString().Contains(Password, StringComparison.Ordinal)).IsFalse();
        await Assert.That(output.ToString().Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        await Assert.That(fixture.Logs.Messages.Contains(Password, StringComparison.Ordinal)
            || fixture.Logs.Messages.Contains(HttpsApplicationFixture.SecretSentinel, StringComparison.Ordinal)).IsFalse();
        await using var after = fixture.Database.Services.CreateAsyncScope();
        var database = after.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(0);
        await Assert.That(await database.UserRoles.CountAsync()).IsEqualTo(0);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task Bootstrap_ExtraArgumentOrMissingConfiguration_FailsSafely(bool extraArgument)
    {
        await using var fixture = await HttpsApplicationFixture.CreateAsync();
        var result = await RunCliAsync(fixture, JsonSerializer.SerializeToUtf8Bytes(new { userName = "safe-failure", initialPassword = Password }),
            extraArgument: extraArgument, missingConfiguration: !extraArgument);
        await Assert.That(result.ExitCode).IsEqualTo(extraArgument ? 2 : 1);
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        await Assert.That(await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Users.CountAsync()).IsEqualTo(0);
    }
    private static async Task<(int ExitCode, string Output)> RunCliAsync(HttpsApplicationFixture fixture, byte[] input, string? applicationName = null,
        bool extraArgument = false, bool missingConfiguration = false)
    {
        await using var scope = fixture.Database.Services.CreateAsyncScope();
        var connection = new NpgsqlConnectionStringBuilder(scope.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .Database.GetConnectionString())
        { ApplicationName = applicationName ?? "Spatia.Bootstrap." + fixture.Database.SchemaName };
        var serverDirectory = Path.GetFullPath("../../../../", AppContext.BaseDirectory);
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            WorkingDirectory = serverDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(Path.Combine(serverDirectory, "Spatia.Server/bin/Release/net10.0/Spatia.Server.dll"));
        start.ArgumentList.Add("bootstrap-admin");
        if (extraArgument)
        {
            start.ArgumentList.Add("synthetic-credential-must-not-appear");
        }
        start.Environment.Remove("SPATIA_TEST_DATABASE_CONNECTION");
        start.Environment["ConnectionStrings__Spatia"] = missingConfiguration ? "" : connection.ConnectionString;
        start.Environment["DataProtection__KeyDirectory"] = fixture.KeyDirectory;
        start.Environment["AllowedHosts"] = "127.0.0.1;localhost";
        start.Environment["DOTNET_ENVIRONMENT"] = "Testing";
        start.Environment["ASPNETCORE_ENVIRONMENT"] = "Testing";
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the private bootstrap check.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.StandardInput.BaseStream.WriteAsync(input);
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch
        {
            if (!process.HasExited)
            {
                process.Kill(true);
                await process.WaitForExitAsync();
            }
            throw;
        }
        var captured = await output + await error;
        await Assert.That(captured.Contains(Password, StringComparison.Ordinal)).IsFalse();
        await Assert.That(captured.Contains("Never overwrite existing credentials!", StringComparison.Ordinal)).IsFalse();
        await Assert.That(captured.Contains("synthetic-credential-must-not-appear", StringComparison.Ordinal)).IsFalse();
        await Assert.That(captured.Contains("Now listening", StringComparison.OrdinalIgnoreCase)).IsFalse();
        return (process.ExitCode, captured);
    }
}
