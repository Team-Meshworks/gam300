using Npgsql;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

internal sealed class PostgresAccountFixture : IAsyncDisposable
{
    private readonly string _databaseConnectionString;
    private bool _schemaCreated;

    private PostgresAccountFixture(string connectionString)
    {
        _databaseConnectionString = ValidateConnectionString(connectionString).ConnectionString;
        SchemaName = "spatia_scrum45_" + Guid.NewGuid().ToString("N");
        var scopedConnection = new NpgsqlConnectionStringBuilder(_databaseConnectionString)
        {
            SearchPath = SchemaName,
            Pooling = false,
        };
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSpatiaAccounts(scopedConnection.ConnectionString);
        Services = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true });
    }

    public string SchemaName { get; }

    public ServiceProvider Services { get; }

    public static NpgsqlConnectionStringBuilder ValidateConnectionString(string connectionString)
    {
        NpgsqlConnectionStringBuilder builder;
        try
        {
            builder = new NpgsqlConnectionStringBuilder(connectionString);
        }
        catch (ArgumentException)
        {
            throw new InvalidOperationException("The disposable PostgreSQL connection configuration is invalid.");
        }

        if ((builder.Host != "127.0.0.1" && builder.Host != "::1") || builder.Database != "spatia_scrum45_test")
        {
            throw new InvalidOperationException("Tests require a literal loopback host and database spatia_scrum45_test.");
        }

        return builder;
    }

    public static async Task<PostgresAccountFixture> CreateAsync()
    {
        var connectionString = Environment.GetEnvironmentVariable("SPATIA_TEST_DATABASE_CONNECTION");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("Set SPATIA_TEST_DATABASE_CONNECTION to the disposable local test database.");
        }

        var fixture = new PostgresAccountFixture(connectionString);
        try
        {
            await using var connection = await fixture.OpenGuardedConnectionAsync();
            await using var createSchema = new NpgsqlCommand($"CREATE SCHEMA \"{fixture.SchemaName}\"", connection);
            await createSchema.ExecuteNonQueryAsync();
            fixture._schemaCreated = true;
            await using var scope = fixture.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.MigrateAsync();
            return fixture;
        }
        catch
        {
            await fixture.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await Services.DisposeAsync();
        if (_schemaCreated)
        {
            await using var connection = await OpenGuardedConnectionAsync();
            await using var dropSchema = new NpgsqlCommand($"DROP SCHEMA \"{SchemaName}\" CASCADE", connection);
            await dropSchema.ExecuteNonQueryAsync();
            _schemaCreated = false;
        }
    }

    private async Task<NpgsqlConnection> OpenGuardedConnectionAsync()
    {
        var connection = new NpgsqlConnection(_databaseConnectionString);
        try
        {
            await connection.OpenAsync();
            await using var currentDatabase = new NpgsqlCommand("SELECT current_database()", connection);
            if ((string?)await currentDatabase.ExecuteScalarAsync() != "spatia_scrum45_test")
            {
                throw new InvalidOperationException("The connected database is not the disposable SCRUM-45 database.");
            }

            return connection;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }
}
