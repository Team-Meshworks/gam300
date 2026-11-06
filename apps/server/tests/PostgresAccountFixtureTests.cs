using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(PostgresAccountFixtureTests))]
public sealed class PostgresAccountFixtureTests
{
    [Test]
    public async Task MigrationScript_JsonBraces_AreExecutedVerbatimAndPersisted()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync(Migration.InitialDatabase);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var script = database.GetService<IMigrator>().GenerateScript();
        const string jsonMigration = """
            START TRANSACTION;
            CREATE TABLE migration_json_braces (
                id integer PRIMARY KEY,
                document jsonb NOT NULL DEFAULT '{"nested":{"value":1},"literal":"{0} and {{braces}}"}'::jsonb
            );
            INSERT INTO migration_json_braces (id) VALUES (1);
            COMMIT;
            """;
        await PostgresAccountFixture.ExecuteMigrationScriptAsync(database, script + "\n" + jsonMigration);
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();

        // Reopen a physical connection to prove the script's commit and JSON value survived unchanged
        await using var connection = new NpgsqlConnection(database.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("SELECT document::text FROM migration_json_braces WHERE id = 1", connection);
        using var document = JsonDocument.Parse((string)(await command.ExecuteScalarAsync())!);
        await Assert.That(document.RootElement.GetProperty("nested").GetProperty("value").GetInt32()).IsEqualTo(1);
        await Assert.That(document.RootElement.GetProperty("literal").GetString()).IsEqualTo("{0} and {{braces}}");
    }

    [Test]
    public async Task ApplicationSchema_MatchesMigrationsAndKeepsStoredDataAndCleanupIsolated()
    {
        await using var migrated = await PostgresAccountFixture.CreateAsync();
        var organizationId = Guid.NewGuid();
        string disposedSchema;
        NpgsqlDataSource applicationPool;
        await using (var host = await HttpsApplicationFixture.CreateAsync())
        {
            var application = host.Database;
            disposedSchema = application.SchemaName;
            await Assert.That(application.SchemaName).IsNotEqualTo(migrated.SchemaName);
            await Assert.That(await ReadCatalogAsync(application)).IsEqualTo(await ReadCatalogAsync(migrated));

            await using (var scope = migrated.Services.CreateAsyncScope())
            {
                var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
                database.Organizations.Add(new Organization { Id = organizationId, Name = "Migration schema" });
                await database.SaveChangesAsync();
            }
            await using (var scope = application.Services.CreateAsyncScope())
            {
                var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
                await Assert.That(await database.Organizations.AnyAsync()).IsFalse();
                await Assert.That(await database.Roles.CountAsync()).IsEqualTo(3);
                await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
                database.Organizations.Add(new Organization { Id = organizationId, Name = "Application schema" });
                await database.SaveChangesAsync();
            }
            var directPid = await ReadOrganizationAsync(application.Services, "Application schema", disposedSchema);
            await Assert.That(await ReadOrganizationAsync(application.Services, "Application schema", disposedSchema))
                .IsNotEqualTo(directPid);

            applicationPool = host.App.Services.GetRequiredService<NpgsqlDataSource>();
            var hostPid = await ReadOrganizationAsync(host.App.Services, "Application schema", disposedSchema);
            await Assert.That(await ReadOrganizationAsync(host.App.Services, "Application schema", disposedSchema))
                .IsEqualTo(hostPid);
            NpgsqlDataSource siblingPool;
            await using (var sibling = await host.CreateSiblingAsync(_ => { }))
            {
                siblingPool = sibling.App.Services.GetRequiredService<NpgsqlDataSource>();
                await Assert.That(await ReadOrganizationAsync(sibling.App.Services, "Application schema", disposedSchema))
                    .IsNotEqualTo(hostPid);
            }
            await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            {
                await using var closed = await siblingPool.OpenConnectionAsync();
            });
            await Assert.That(await ReadOrganizationAsync(host.App.Services, "Application schema", disposedSchema))
                .IsEqualTo(hostPid);
        }
        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
        {
            await using var closed = await applicationPool.OpenConnectionAsync();
        });

        // Disposing one schema must leave the other schema and its same-ID record intact
        await using var verification = migrated.Services.CreateAsyncScope();
        var remaining = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That((await remaining.Organizations.SingleAsync()).Name).IsEqualTo("Migration schema");
        await remaining.Database.OpenConnectionAsync();
        await using var schema = new NpgsqlCommand("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = @schema)",
            (NpgsqlConnection)remaining.Database.GetDbConnection());
        schema.Parameters.AddWithValue("schema", disposedSchema);
        await Assert.That((bool)(await schema.ExecuteScalarAsync())!).IsFalse();
    }

    private static async Task<int> ReadOrganizationAsync(IServiceProvider services, string name, string schema)
    {
        await using var scope = services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await database.Database.OpenConnectionAsync();
        await Assert.That((await database.Organizations.SingleAsync()).Name).IsEqualTo(name);
        await Assert.That(await database.Database.SqlQuery<string>($"SELECT current_schema() AS \"Value\"").SingleAsync())
            .IsEqualTo(schema);
        return ((NpgsqlConnection)database.Database.GetDbConnection()).ProcessID;
    }

    private static async Task<string> ReadCatalogAsync(PostgresAccountFixture fixture)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await using var connection = new NpgsqlConnection(database.Database.GetConnectionString());
        await connection.OpenAsync();
        const string sql = """
            SELECT 'relation|' || c.relname || '|' || c.relkind::text
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
            UNION ALL
            SELECT 'column|' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
                || '|' || a.attnotnull || '|' || a.attidentity::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
            WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            UNION ALL
            SELECT 'constraint|' || c.relname || '|' || con.conname || '|' || pg_get_constraintdef(con.oid)
            FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
            UNION ALL SELECT 'index|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = current_schema()
            UNION ALL SELECT 'role|' || row_to_json(r)::text FROM "AspNetRoles" r
            UNION ALL SELECT 'migration|' || row_to_json(m)::text FROM "__EFMigrationsHistory" m
            ORDER BY 1
            """;
        await using var command = new NpgsqlCommand(sql, connection);
        await using var reader = await command.ExecuteReaderAsync();
        var rows = new List<string>();
        while (await reader.ReadAsync())
        {
            rows.Add(reader.GetString(0).Replace(fixture.SchemaName, "owned_schema", StringComparison.Ordinal));
        }
        return string.Join('\n', rows);
    }
}
