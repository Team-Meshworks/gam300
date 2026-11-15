using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel(nameof(CreationDeploymentGateTests))]
public sealed class CreationDeploymentGateTests
{
    [Test]
    [Arguments("20261114135210_AddCreationReceipts", "SELECT actor_id, operation_id, purpose, sequence, acknowledged, source_project_id", PostgresErrorCodes.UndefinedColumn)]
    [Arguments("20261114150108_AddCreationGenerations", "SELECT actor_id, intent_digest, kind, purpose, organization_id, source_project_id", PostgresErrorCodes.UndefinedTable)]
    public async Task DeploymentRuntimeRoleGateRejectsOldSchemaAndReadsFinalGenerationColumnsWithoutDataChanges(string migration, string projectionStart, string errorCode)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync(migration);
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var root = new DirectoryInfo(AppContext.BaseDirectory);

        while (root is not null && !File.Exists(Path.Combine(root.FullName, "compose.server.yaml")))
            root = root.Parent;

        var compose = await File.ReadAllTextAsync(Path.Combine(root!.FullName, "compose.server.yaml"));
        var start = compose.IndexOf(projectionStart, StringComparison.Ordinal);

        await Assert.That(start).IsGreaterThanOrEqualTo(0);

        var projection = compose[start..(compose.IndexOf(';', start) + 1)];
        var identifiers = new NpgsqlCommandBuilder();
        var schema = identifiers.QuoteIdentifier(fixture.SchemaName);
        var database = identifiers.QuoteIdentifier("spatia_scrum45_test");
        var roleName = fixture.SchemaName + "_runtime";
        var role = identifiers.QuoteIdentifier(roleName);
        var grantStart = compose.IndexOf("GRANT CONNECT ON DATABASE spatia TO spatia_api;", StringComparison.Ordinal);
        var grantEnd = compose.IndexOf("SET ROLE spatia_api;", grantStart) + "SET ROLE spatia_api;".Length;
        var grants = $"CREATE ROLE {role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
            + compose[grantStart..grantEnd].Replace("ON DATABASE spatia", "ON DATABASE " + database, StringComparison.Ordinal)
                .Replace("SCHEMA public", "SCHEMA " + schema, StringComparison.Ordinal)
                .Replace("public.", schema + ".", StringComparison.Ordinal)
                .Replace("spatia_api", role, StringComparison.Ordinal);
        projection = projection.Replace("public.", schema + ".", StringComparison.Ordinal);
        var historyProbe = $"SELECT * FROM {schema}.\"__EFMigrationsHistory\" LIMIT 0";

        await using (var transaction = await db.Database.BeginTransactionAsync())
        {
            await db.Database.ExecuteSqlRawAsync(grants);

            await Assert.That(await db.Database.SqlQuery<string>($"SELECT current_user::text AS \"Value\"").SingleAsync()).IsEqualTo(roleName);

            var failure = await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlRawAsync(projection));

            await Assert.That(failure!.SqlState).IsEqualTo(errorCode);

            await transaction.RollbackAsync();
        }

        await db.Database.MigrateAsync();

        await using (var transaction = await db.Database.BeginTransactionAsync())
        {
            await db.Database.ExecuteSqlRawAsync(grants);

            await Assert.That(await db.Database.SqlQuery<string>($"SELECT current_user::text AS \"Value\"").SingleAsync()).IsEqualTo(roleName);

            await db.Database.ExecuteSqlRawAsync(projection);

            await Assert.That(await db.Database.SqlQuery<long>($"SELECT count(*) AS \"Value\" FROM creation_receipts").SingleAsync()).IsEqualTo(0L);

            var failure = await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlRawAsync(historyProbe));

            await Assert.That(failure!.SqlState).IsEqualTo(PostgresErrorCodes.InsufficientPrivilege);

            await transaction.RollbackAsync();
        }

        await Assert.That(await db.Database.SqlQuery<bool>($"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {roleName}) AS \"Value\"").SingleAsync()).IsFalse();
        await Assert.That(await db.Set<CreationReceipt>().CountAsync()).IsEqualTo(0);
        await Assert.That(await db.Database.SqlQuery<long>($"SELECT count(*) AS \"Value\" FROM legacy_creation_bindings").SingleAsync()).IsEqualTo(0L);
    }
}
