using System.Data;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class PublicationPersistenceTests
{
    private const string DraftMigration = "20261018091152_AddProjectDraftStorage";
    private static readonly Guid ProjectId = Guid.Parse("abcdefab-abcd-4abc-8abc-abcdefabcdef");
    private static readonly Guid OrganizationId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid ActorId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid PublicationId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly byte[] Digest = Enumerable.Range(0, 32).Select(index => (byte)index).ToArray();
    private static readonly DateTimeOffset DraftTime = new(2026, 10, 29, 0, 0, 0, TimeSpan.Zero);

    [Test]
    public async Task PublicationDatabase_RuntimeDeleteCannotReplaceAnExistingEdition()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var role = "publication_runtime_" + Guid.NewGuid().ToString("N");

        // Give a disposable runtime role ordinary table grants without ownership or trigger privileges
        // Roll back its creation and grants together so no cluster-wide test role is retained
        await using (var transaction = await database.Database.BeginTransactionAsync())
        {
            // PostgreSQL identifiers cannot be parameters; both names contain only generated GUID hex and fixed prefixes
            foreach (var sql in new[] {
                $"CREATE ROLE {role} NOLOGIN", $"GRANT USAGE ON SCHEMA {fixture.SchemaName} TO {role}",
                $"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {fixture.SchemaName} TO {role}", $"SET LOCAL ROLE {role}" })
            {
                await using var command = database.Database.GetDbConnection().CreateCommand();
                command.Transaction = transaction.GetDbTransaction();
                command.CommandText = sql;
                await command.ExecuteNonQueryAsync();
            }
            var failure = await Assert.ThrowsAsync<PostgresException>(async () =>
                await database.Database.ExecuteSqlRawAsync("DELETE FROM publications"));
            await Assert.That(failure!.SqlState).IsEqualTo("23514");
            await Assert.That(failure.ConstraintName).IsEqualTo("CK_publications_immutable");
            await transaction.RollbackAsync();
        }
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await AssertJsonAsync((await ReadAsync(fixture)).DocumentJson, Document());
    }

    [Test]
    public async Task PublicationDatabase_DeletedPolicyCannotBeResetOrReplaced()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        database.PublicationAccess.Add(new PublicationAccessState { PublicationId = PublicationId, Deleted = true });
        await database.SaveChangesAsync();

        // Permanent link deletion survives ordinary updates and policy-row replacement attempts
        foreach (var sql in new[] { "UPDATE publication_access SET \"Deleted\" = false", "DELETE FROM publication_access" })
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(async () => await database.Database.ExecuteSqlRawAsync(sql));
            await Assert.That(failure!.ConstraintName).IsEqualTo("CK_publication_access_permanent");
        }
        await Assert.That((await database.PublicationAccess.AsNoTracking().SingleAsync()).Deleted).IsTrue();
    }

    [Test]
    public async Task PublicationDatabase_RuntimePolicyIdentityIsImmutable()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync("20261104191214_ProtectPublicationHistory");
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        var other = Guid.NewGuid();
        await InsertAsync(fixture, Edition(other));
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        database.PublicationAccess.Add(new PublicationAccessState { PublicationId = PublicationId, Deleted = true });
        await database.SaveChangesAsync();
        await database.Database.MigrateAsync();
        var role = "publication_runtime_" + Guid.NewGuid().ToString("N");
        await using (var transaction = await database.Database.BeginTransactionAsync())
        {
            foreach (var sql in new[] {
                $"CREATE ROLE {role} NOLOGIN", $"GRANT USAGE ON SCHEMA {fixture.SchemaName} TO {role}",
                $"GRANT SELECT, UPDATE ON publication_access TO {role}", $"SET LOCAL ROLE {role}" })
            {
                await using var command = database.Database.GetDbConnection().CreateCommand();
                command.Transaction = transaction.GetDbTransaction();
                command.CommandText = sql;
                await command.ExecuteNonQueryAsync();
            }
            var failure = await Assert.ThrowsAsync<PostgresException>(async () =>
                await database.Database.ExecuteSqlInterpolatedAsync($"UPDATE publication_access SET \"PublicationId\" = {other} WHERE \"PublicationId\" = {PublicationId}"));
            await Assert.That(failure!.ConstraintName).IsEqualTo("CK_publication_access_permanent");
            await transaction.RollbackAsync();
        }
        var retained = await database.PublicationAccess.AsNoTracking().SingleAsync();
        await Assert.That(retained.PublicationId).IsEqualTo(PublicationId);
        await Assert.That(retained.Deleted).IsTrue();
    }

    [Test]
    [Arguments(1, 0L)]
    [Arguments(2, Project.MaxRevision)]
    public async Task PublicationDatabase_FreshMigrationRoundTripsCompleteEditionInANewContext(int version, long revision)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture, version, revision);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = Db(scope);
            database.Publications.Add(Edition(version: version, revision: revision));
            await database.SaveChangesAsync();
            await database.Database.MigrateAsync();
            await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
        }

        var stored = await ReadAsync(fixture);
        await Assert.That(stored.Id).IsEqualTo(PublicationId);
        await Assert.That(stored.ProjectId).IsEqualTo(ProjectId);
        await Assert.That(stored.PublishedById).IsEqualTo(ActorId);
        await Assert.That(stored.SourceRevision).IsEqualTo(revision);
        await Assert.That(stored.SchemaVersion).IsEqualTo(version);
        await Assert.That(stored.RequestDigest.SequenceEqual(Digest)).IsTrue();
        await Assert.That(stored.CreatedAt > DateTimeOffset.UnixEpoch).IsTrue();
        await Assert.That(stored.CreatedAt.Offset).IsEqualTo(TimeSpan.Zero);
        await AssertJsonAsync(stored.DocumentJson, Document(version));
        await AssertJsonAsync(stored.AssetReferencesJson, Manifest());
    }

    [Test]
    public async Task PublicationDatabase_UpgradeAndRepeatedIdempotentScriptPreserveExistingDraftAndPublication()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync(DraftMigration);
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var script = database.GetService<IMigrator>().GenerateScript(options: MigrationsSqlGenerationOptions.Idempotent);

        await PostgresAccountFixture.ExecuteMigrationScriptAsync(database, script);
        database.Publications.Add(Edition());
        await database.SaveChangesAsync();
        var original = await ReadAsync(fixture);
        await PostgresAccountFixture.ExecuteMigrationScriptAsync(database, script);
        await database.Database.MigrateAsync();

        var stored = await ReadAsync(fixture);
        await Assert.That(stored.CreatedAt).IsEqualTo(original.CreatedAt);
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(1);
        await Assert.That(await database.Roles.CountAsync()).IsEqualTo(3);
        var draft = await database.Projects.AsNoTracking().SingleAsync();
        await Assert.That(draft.Revision).IsEqualTo(7L);
        await Assert.That(draft.UpdatedAt).IsEqualTo(DraftTime);
        await AssertJsonAsync(draft.DocumentJson, Document());
        await Assert.That(await database.Database.GetPendingMigrationsAsync()).IsEmpty();
    }

    [Test]
    public async Task PublicationDatabase_MigrationDownAndReapplyPreservePreexistingDraft()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var migrator = database.GetService<IMigrator>();

        await migrator.MigrateAsync(DraftMigration);
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
        await database.Database.MigrateAsync();
        database.Publications.Add(Edition());
        await database.SaveChangesAsync();

        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
        await AssertJsonAsync((await database.Projects.AsNoTracking().SingleAsync()).DocumentJson, Document());
    }

    [Test]
    public async Task PublicationDatabase_LaterDraftEditsAndEditionsDoNotChangeSnapshotOrForgetRetryIdentity()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        var original = await ReadAsync(fixture);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = Db(scope);
            var draft = await database.Projects.SingleAsync();
            draft.Revision = 8;
            draft.DocumentJson = Document(title: "Later metadata edit");
            draft.IsArchived = true;
            await database.SaveChangesAsync();
            // This is a storage test, not a coordinator: no archived project is authorized here.
            database.Publications.Add(Edition(Guid.NewGuid(), revision: 8, title: "Later metadata edit"));
            await database.SaveChangesAsync();
        }

        var stored = await ReadAsync(fixture);
        await AssertJsonAsync(stored.DocumentJson, original.DocumentJson);
        await AssertJsonAsync(stored.AssetReferencesJson, original.AssetReferencesJson);
        await Assert.That(stored.CreatedAt).IsEqualTo(original.CreatedAt);
        await Assert.That(stored.SourceRevision).IsEqualTo(7L);
        await Assert.That(PublicationRetryPolicy.Decide(stored, PublicationId, ProjectId, ActorId, 7, Digest))
            .IsEqualTo(PublicationRetryDecision.Replay);
    }

    [Test]
    public async Task PublicationDatabase_RowAndEntireManifestAreInvisibleUntilCommit()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        database.Publications.Add(Edition());
        await database.SaveChangesAsync();

        await using (var reader = fixture.Services.CreateAsyncScope())
        {
            await Assert.That(await Db(reader).Publications.AnyAsync()).IsFalse();
        }
        await transaction.CommitAsync();

        await AssertJsonAsync((await ReadAsync(fixture)).AssetReferencesJson, Manifest());
    }

    [Test]
    public async Task PublicationDatabase_RollbackLeavesNoEditionAndTheSameIdCanBeRetried()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var database = Db(scope);
            await using var transaction = await database.Database.BeginTransactionAsync();
            database.Publications.Add(Edition());
            await database.SaveChangesAsync();
            await transaction.RollbackAsync();
        }
        await using (var reader = fixture.Services.CreateAsyncScope())
        {
            await Assert.That(await Db(reader).Publications.AnyAsync()).IsFalse();
        }

        await InsertAsync(fixture, Edition());
        await Assert.That((await ReadAsync(fixture)).Id).IsEqualTo(PublicationId);
    }

    [Test]
    public async Task PublicationDatabase_FailedBatchDoesNotLeaveAPartialEdition()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        database.Publications.Add(Edition());
        var invalid = Edition(Guid.NewGuid());
        database.Publications.Add(invalid);
        database.Entry(invalid).Property(row => row.AssetReferencesJson).CurrentValue = "[{}]";

        await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await using var reader = fixture.Services.CreateAsyncScope();
        await Assert.That(await Db(reader).Publications.AnyAsync()).IsFalse();
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationDatabase_ConcurrentClaimsOfOneIdCannotCreateTwoEditions(bool firstCommits)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var firstScope = fixture.Services.CreateAsyncScope();
        var first = Db(firstScope);
        await using var firstTransaction = await first.Database.BeginTransactionAsync();
        first.Publications.Add(Edition());
        await first.SaveChangesAsync();

        await using var secondScope = fixture.Services.CreateAsyncScope();
        var second = Db(secondScope);
        await second.Database.OpenConnectionAsync();
        var pid = ((NpgsqlConnection)second.Database.GetDbConnection()).ProcessID;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        second.Publications.Add(Edition(title: "Competing snapshot"));
        var pending = second.SaveChangesAsync(timeout.Token);
        try
        {
            await WaitForLockAsync(fixture, pid, timeout.Token);
            if (firstCommits)
            {
                await firstTransaction.CommitAsync();
                var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await pending);
                await AssertConstraintAsync(error, PostgresErrorCodes.UniqueViolation, "PK_publications");
            }
            else
            {
                await firstTransaction.RollbackAsync();
                await pending;
            }
        }
        finally
        {
            // Release a failed test's database work before fixture cleanup.
            await firstTransaction.DisposeAsync();
            await timeout.CancelAsync();
            try { await pending; } catch (Exception) { }
        }

        await using var reader = fixture.Services.CreateAsyncScope();
        await Assert.That(await Db(reader).Publications.CountAsync()).IsEqualTo(1);
        await AssertJsonAsync((await ReadAsync(fixture)).DocumentJson,
            Document(title: firstCommits ? "Original edition" : "Competing snapshot"));
    }

    [Test]
    [Arguments(nameof(Publication.Id))]
    [Arguments(nameof(Publication.ProjectId))]
    [Arguments(nameof(Publication.PublishedById))]
    [Arguments(nameof(Publication.SourceRevision))]
    [Arguments(nameof(Publication.SchemaVersion))]
    [Arguments(nameof(Publication.DocumentJson))]
    [Arguments(nameof(Publication.AssetReferencesJson))]
    [Arguments(nameof(Publication.RequestDigest))]
    [Arguments(nameof(Publication.CreatedAt))]
    public async Task PublicationDatabase_DirectSqlCannotUpdateAnySnapshotField(string field)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        // Fixed SQL only; even a no-op UPDATE is forbidden, including identity and manifest changes.
        var sql = field switch
        {
            nameof(Publication.Id) => "UPDATE publications SET id = id",
            nameof(Publication.ProjectId) => "UPDATE publications SET project_id = project_id",
            nameof(Publication.PublishedById) => "UPDATE publications SET published_by_id = published_by_id",
            nameof(Publication.SourceRevision) => "UPDATE publications SET source_revision = source_revision + 1",
            nameof(Publication.SchemaVersion) => "UPDATE publications SET schema_version = schema_version + 1",
            nameof(Publication.DocumentJson) => "UPDATE publications SET document = jsonb_build_object()",
            nameof(Publication.AssetReferencesJson) => "UPDATE publications SET asset_references = '[]'::jsonb",
            nameof(Publication.RequestDigest) => "UPDATE publications SET request_digest = decode(repeat('ff', 32), 'hex')",
            nameof(Publication.CreatedAt) => "UPDATE publications SET created_at = statement_timestamp()",
            _ => throw new ArgumentOutOfRangeException(nameof(field)),
        };

        var error = await Assert.ThrowsAsync<PostgresException>(async () => await database.Database.ExecuteSqlRawAsync(sql));

        await Assert.That(error!.SqlState).IsEqualTo(PostgresErrorCodes.CheckViolation);
        await Assert.That(error.ConstraintName).IsEqualTo("CK_publications_immutable");
        await AssertJsonAsync((await ReadAsync(fixture)).DocumentJson, Document());
        await AssertJsonAsync((await ReadAsync(fixture)).AssetReferencesJson, Manifest());
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationDatabase_RuntimeRoleCannotDeleteCommittedEdition(bool upgrade)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync(
            upgrade ? "20261103080036_AddAccountDisplayName" : null);
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        var original = await ReadAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        await database.Database.MigrateAsync();
        var role = "publication_test_" + Guid.NewGuid().ToString("N");
        await using (var transaction = await database.Database.BeginTransactionAsync())
        {
            // Match the runtime DML grants without ownership or migration privileges.
            // Role creation is transactional, so rollback also removes this fixture role.
            using var identifiers = new NpgsqlCommandBuilder();
            var quotedRole = identifiers.QuoteIdentifier(role);
            var quotedSchema = identifiers.QuoteIdentifier(fixture.SchemaName);
            var setup = $"CREATE ROLE {quotedRole} NOLOGIN; " +
                $"GRANT USAGE ON SCHEMA {quotedSchema} TO {quotedRole}; " +
                $"GRANT SELECT, INSERT, UPDATE, DELETE ON publications TO {quotedRole}; " +
                $"SET LOCAL ROLE {quotedRole}";
            await database.Database.ExecuteSqlRawAsync(setup);
            await Assert.That(await database.Publications.AsNoTracking().CountAsync()).IsEqualTo(1);
            var error = await Assert.ThrowsAsync<PostgresException>(async () =>
                await database.Database.ExecuteSqlRawAsync("DELETE FROM publications"));
            await Assert.That(error!.SqlState).IsEqualTo(PostgresErrorCodes.CheckViolation);
            await Assert.That(error.ConstraintName).IsEqualTo("CK_publications_immutable");
            await transaction.RollbackAsync();
        }

        var stored = await ReadAsync(fixture);
        await AssertJsonAsync(stored.DocumentJson, original.DocumentJson);
        await AssertJsonAsync(stored.AssetReferencesJson, original.AssetReferencesJson);
        await Assert.That(stored.CreatedAt).IsEqualTo(original.CreatedAt);
        await Assert.That(PublicationRetryPolicy.Decide(stored, PublicationId, ProjectId, ActorId, 7, Digest))
            .IsEqualTo(PublicationRetryDecision.Replay);
    }

    [Test]
    [Arguments(false)]
    [Arguments(true)]
    public async Task PublicationDatabase_EfTrackedDigestMutationCannotAlterRetryHistory(bool replaceArray)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var stored = await database.Publications.SingleAsync();
        if (replaceArray)
        {
            var changed = stored.RequestDigest.ToArray();
            changed[0] ^= 1;
            database.Entry(stored).Property(row => row.RequestDigest).CurrentValue = changed;
            var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
            await AssertConstraintAsync(error, PostgresErrorCodes.CheckViolation, "CK_publications_immutable");
        }
        else
        {
            // EF's default non-key byte[] comparison ignores an in-place edit; nothing reaches storage.
            stored.RequestDigest[0] ^= 1;
            await Assert.That(await database.SaveChangesAsync()).IsEqualTo(0);
        }
        await Assert.That((await ReadAsync(fixture)).RequestDigest.SequenceEqual(Digest)).IsTrue();
    }

    [Test]
    [Arguments("revision-negative", "CK_publications_source_revision")]
    [Arguments("revision-excessive", "CK_publications_source_revision")]
    [Arguments("schema-zero", "CK_publications_schema_version")]
    [Arguments("empty-id", "CK_publications_id")]
    [Arguments("short-digest", "CK_publications_request_digest")]
    [Arguments("long-digest", "CK_publications_request_digest")]
    [Arguments("infinite-time", "CK_publications_created_at")]
    public async Task PublicationDatabase_InvalidMetadataCannotCreateAnEdition(string problem, string constraint)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var edition = Edition(problem == "empty-id" ? Guid.Empty : PublicationId);
        database.Publications.Add(edition);
        var entry = database.Entry(edition);
        switch (problem)
        {
            case "revision-negative": entry.Property(row => row.SourceRevision).CurrentValue = -1; break;
            case "revision-excessive": entry.Property(row => row.SourceRevision).CurrentValue = Project.MaxRevision + 1; break;
            case "schema-zero":
                entry.Property(row => row.SchemaVersion).CurrentValue = 0;
                entry.Property(row => row.DocumentJson).CurrentValue = $$"""{"projectId":"{{ProjectId}}","schemaVersion":0}""";
                break;
            case "short-digest": entry.Property(row => row.RequestDigest).CurrentValue = new byte[31]; break;
            case "long-digest": entry.Property(row => row.RequestDigest).CurrentValue = new byte[33]; break;
            case "infinite-time": entry.Property(row => row.CreatedAt).CurrentValue = DateTimeOffset.MaxValue; break;
        }

        var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(error, PostgresErrorCodes.CheckViolation, constraint);
        await using var reader = fixture.Services.CreateAsyncScope();
        await Assert.That(await Db(reader).Publications.AnyAsync()).IsFalse();
    }

    [Test]
    [Arguments("null")]
    [Arguments("[]")]
    [Arguments("{}")]
    [Arguments("{\"projectId\":null,\"schemaVersion\":1}")]
    [Arguments("{\"projectId\":42,\"schemaVersion\":1}")]
    [Arguments("{\"projectId\":\"$id\"}")]
    [Arguments("{\"projectId\":\"$id\",\"schemaVersion\":\"1\"}")]
    [Arguments("{\"projectId\":\"$id\",\"schemaVersion\":2}")]
    [Arguments("{\"projectId\":\"44444444-4444-4444-8444-444444444444\",\"schemaVersion\":1}")]
    public async Task PublicationDatabase_DocumentMustMatchSourceProjectAndSchema(string json) =>
        await AssertInvalidColumnAsync(nameof(Publication.DocumentJson),
            json.Replace("$id", ProjectId.ToString("D"), StringComparison.Ordinal), "CK_publications_document");

    [Test]
    [Arguments("null")]
    [Arguments("{}")]
    [Arguments("\"asset-v1\"")]
    [Arguments("[null]")]
    [Arguments("[42]")]
    [Arguments("[[]]")]
    [Arguments("[{}]")]
    [Arguments("[{\"sha256\":\"$hash\"}]")]
    [Arguments("[{\"assetId\":\"\",\"sha256\":\"$hash\"}]")]
    [Arguments("[{\"assetId\":null,\"sha256\":\"$hash\"}]")]
    [Arguments("[{\"assetId\":42,\"sha256\":\"$hash\"}]")]
    [Arguments("[{\"assetId\":\" \t\",\"sha256\":\"$hash\"}]")]
    [Arguments("[{\"assetId\":\"room-v1\"}]")]
    [Arguments("[{\"assetId\":\"room-v1\",\"sha256\":null}]")]
    [Arguments("[{\"assetId\":\"room-v1\",\"sha256\":42}]")]
    [Arguments("[{\"assetId\":\"room-v1\",\"sha256\":\"short\"}]")]
    [Arguments("[{\"assetId\":\"room-v1\",\"sha256\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}]")]
    [Arguments("[{\"assetId\":\"room-v1\",\"sha256\":\"$hash\",\"url\":\"https://mutable.invalid/current.glb\"}]")]
    [Arguments("[{\"assetId\":\"room-v1\",\"sha256\":\"$hash\"},{\"assetId\":\"room-v1\",\"sha256\":\"$hash\"}]")]
    public async Task PublicationDatabase_ManifestMustContainOnlyUniqueCompleteImmutableReferences(string json) =>
        await AssertInvalidColumnAsync(nameof(Publication.AssetReferencesJson),
            json.Replace("$hash", new string('a', 64), StringComparison.Ordinal).Replace("\t", "\\t", StringComparison.Ordinal),
            "CK_publications_asset_references");

    [Test]
    [Arguments(nameof(Publication.DocumentJson))]
    [Arguments(nameof(Publication.AssetReferencesJson))]
    [Arguments(nameof(Publication.RequestDigest))]
    public async Task PublicationDatabase_RequiredSnapshotFieldsCannotBeSqlNull(string field)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var edition = Edition();
        database.Publications.Add(edition);
        database.Entry(edition).Property(field).CurrentValue = null;

        var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await Assert.That((error!.InnerException as PostgresException)!.SqlState).IsEqualTo(PostgresErrorCodes.NotNullViolation);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task PublicationDatabase_MissingSourceProjectOrActorIsRejected(bool missingProject)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var edition = Edition();
        database.Publications.Add(edition);
        var missingId = Guid.NewGuid();
        if (missingProject)
        {
            database.Entry(edition).Property(row => row.ProjectId).CurrentValue = missingId;
            database.Entry(edition).Property(row => row.DocumentJson).CurrentValue = ProjectTestDocuments.Create(missingId, "Missing source");
        }
        else
        {
            database.Entry(edition).Property(row => row.PublishedById).CurrentValue = missingId;
        }

        var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await Assert.That((error!.InnerException as PostgresException)!.SqlState).IsEqualTo(PostgresErrorCodes.ForeignKeyViolation);
    }

    [Test]
    [Arguments(true)]
    [Arguments(false)]
    public async Task PublicationDatabase_SourceDeletionDoesNotCascadeIntoPublishedHistory(bool deleteProject)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);

        var error = await Assert.ThrowsAsync<PostgresException>(async () =>
            await database.Database.ExecuteSqlRawAsync(deleteProject ? "DELETE FROM projects" : "DELETE FROM \"AspNetUsers\""));

        await Assert.That(error!.SqlState).IsEqualTo(PostgresErrorCodes.RestrictViolation);
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(1);
    }

    [Test]
    public async Task PublicationDatabase_DistinctIdsCanCaptureTheSameSavedRevision()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await InsertAsync(fixture, Edition(Guid.NewGuid()));

        await using var reader = fixture.Services.CreateAsyncScope();
        await Assert.That(await Db(reader).Publications.CountAsync(row => row.SourceRevision == 7)).IsEqualTo(2);
    }

    [Test]
    public async Task PublicationDatabase_PublicationIdsAreUniqueAcrossProjects()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await InsertAsync(fixture, Edition());
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var otherProject = Guid.NewGuid();
        var otherDocument = ProjectTestDocuments.Create(otherProject, "Other project");
        database.Projects.Add(new Project
        {
            Id = otherProject,
            OrganizationId = OrganizationId,
            Revision = 7,
            SchemaVersion = 1,
            DocumentJson = otherDocument,
            UpdatedAt = DraftTime,
        });
        await database.SaveChangesAsync();
        var conflicting = Edition();
        database.Publications.Add(conflicting);
        database.Entry(conflicting).Property(row => row.ProjectId).CurrentValue = otherProject;
        database.Entry(conflicting).Property(row => row.DocumentJson).CurrentValue = otherDocument;

        var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(error, PostgresErrorCodes.UniqueViolation, "PK_publications");
        await Assert.That((await ReadAsync(fixture)).ProjectId).IsEqualTo(ProjectId);
        await AssertJsonAsync((await ReadAsync(fixture)).DocumentJson, Document());
    }

    [Test]
    public async Task PublicationDatabase_CaseSensitiveAndEscapedAssetIdsRoundTrip()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var manifest = PublicationAssetManifest.Serialize([
            new("Room-v1", new string('a', 64)), new("room-v1", new string('b', 64)),
            new("Synthetic 'quoted' \"asset\"; --", new string('c', 64)),
        ]);
        var edition = Edition();
        database.Publications.Add(edition);
        database.Entry(edition).Property(row => row.AssetReferencesJson).CurrentValue = manifest;

        await database.SaveChangesAsync();

        await AssertJsonAsync((await ReadAsync(fixture)).AssetReferencesJson, manifest);
        await Assert.That(await database.Projects.CountAsync()).IsEqualTo(1);
    }

    private static async Task AssertInvalidColumnAsync(string property, string json, string constraint)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await SeedAsync(fixture);
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        var edition = Edition();
        database.Publications.Add(edition);
        database.Entry(edition).Property(property).CurrentValue = json;

        var error = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());

        await AssertConstraintAsync(error, PostgresErrorCodes.CheckViolation, constraint);
        await using var reader = fixture.Services.CreateAsyncScope();
        await Assert.That(await Db(reader).Publications.AnyAsync()).IsFalse();
    }

    private static async Task WaitForLockAsync(PostgresAccountFixture fixture, int pid, CancellationToken cancellationToken)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var waiting = await database.Database.SqlQuery<bool>($"""
                SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = {pid} AND wait_event_type = 'Lock') AS "Value"
                """).SingleAsync(cancellationToken);
            if (waiting)
            {
                return;
            }
            await Task.Delay(20, cancellationToken);
        }
    }

    private static async Task SeedAsync(PostgresAccountFixture fixture, int version = 1, long revision = 7)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        database.Organizations.Add(new Organization { Id = OrganizationId, Name = "Synthetic publication school" });
        await LegacyAccountSeed.InsertAsync(database,
            new ApplicationUser { Id = ActorId, UserName = "publication-user", NormalizedUserName = "PUBLICATION-USER" });
        database.Projects.Add(new Project
        {
            Id = ProjectId,
            OrganizationId = OrganizationId,
            Revision = revision,
            SchemaVersion = version,
            DocumentJson = Document(version),
            UpdatedAt = DraftTime,
        });
        await database.SaveChangesAsync();
    }

    private static Publication Edition(Guid? id = null, int version = 1, long revision = 7, string title = "Original edition") => new()
    {
        Id = id ?? PublicationId,
        ProjectId = ProjectId,
        PublishedById = ActorId,
        SourceRevision = revision,
        SchemaVersion = version,
        DocumentJson = Document(version, title),
        AssetReferencesJson = Manifest(),
        RequestDigest = Digest.ToArray(),
    };

    private static string Document(int version = 1, string title = "Original edition") =>
        ProjectTestDocuments.Create(ProjectId, title, version);

    private static string Manifest() => PublicationAssetManifest.Serialize([
        new("test-room-v1", new string('a', 64)), new("test-crate-v1", new string('b', 64)),
    ]);

    private static ApplicationDbContext Db(AsyncServiceScope scope) => scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

    private static async Task InsertAsync(PostgresAccountFixture fixture, Publication edition)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = Db(scope);
        database.Publications.Add(edition);
        await database.SaveChangesAsync();
    }

    private static async Task<Publication> ReadAsync(PostgresAccountFixture fixture)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        return await Db(scope).Publications.AsNoTracking().SingleAsync(row => row.Id == PublicationId);
    }

    private static async Task AssertJsonAsync(string actual, string expected) =>
        await Assert.That(JsonNode.DeepEquals(JsonNode.Parse(actual), JsonNode.Parse(expected))).IsTrue();

    private static async Task AssertConstraintAsync(DbUpdateException? error, string sqlState, string constraint)
    {
        var postgres = error?.InnerException as PostgresException
            ?? throw new InvalidOperationException("Expected a PostgreSQL integrity failure.");
        await Assert.That(postgres.SqlState).IsEqualTo(sqlState);
        await Assert.That(postgres.ConstraintName).IsEqualTo(constraint);
    }
}
