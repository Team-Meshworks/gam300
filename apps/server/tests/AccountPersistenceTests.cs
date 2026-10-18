using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountPersistenceTests
{
    private const string TestPassword = "Initial-example1!";

    [Test]
    public async Task Migration_RealPostgres_CreatesIdentityStoresAndSeededRolesInOwnedSchema()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await database.Roles.CountAsync()).IsEqualTo(3);
        await Assert.That(await database.Roles.AnyAsync(role => role.Id == ApplicationRoles.AdministratorId &&
            role.Name == ApplicationRoles.Administrator && role.NormalizedName == "ADMINISTRATOR")).IsTrue();
        await Assert.That(await database.Roles.AnyAsync(role => role.Id == ApplicationRoles.EducatorId &&
            role.Name == ApplicationRoles.Educator && role.NormalizedName == "EDUCATOR")).IsTrue();
        await Assert.That(await database.Roles.AnyAsync(role => role.Id == ApplicationRoles.CreatorId &&
            role.Name == ApplicationRoles.Creator && role.NormalizedName == "CREATOR")).IsTrue();
        await database.Database.OpenConnectionAsync();
        await using var schema = database.Database.GetDbConnection().CreateCommand();
        schema.CommandText = "SELECT current_schema()";
        await Assert.That((string?)await schema.ExecuteScalarAsync()).IsEqualTo(fixture.SchemaName);
        await CreateUserAsync(scope.ServiceProvider, "migration-preserved-user");
        await database.Database.MigrateAsync();
        await Assert.That(await database.Roles.CountAsync()).IsEqualTo(3);
        await Assert.That(await database.Users.CountAsync()).IsEqualTo(1);
    }

    [Test]
    public async Task IdentityStore_ReopenedConnection_PreservesHashFlagsStampsAndUtcLockout()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        Guid userId;
        string? originalStamp;
        var lockout = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = await CreateUserAsync(scope.ServiceProvider, "durable-user");
            userId = user.Id;
            originalStamp = user.SecurityStamp;
            await Assert.That(user.IsActive).IsTrue();
            await Assert.That(user.MustChangePassword).IsTrue();
            await Assert.That(!string.IsNullOrEmpty(user.PasswordHash) && user.PasswordHash != TestPassword).IsTrue();
            await RequireSuccessAsync(await manager.UpdateSecurityStampAsync(user));
            user.IsActive = false;
            user.MustChangePassword = false;
            user.LockoutEnd = lockout;
            user.AccessFailedCount = 2;
            await RequireSuccessAsync(await manager.UpdateAsync(user));
            await RequireSuccessAsync(await manager.AddToRoleAsync(user, ApplicationRoles.Creator));
        }

        await using var reopened = fixture.Services.CreateAsyncScope();
        var reopenedManager = reopened.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var persisted = await reopenedManager.FindByIdAsync(userId.ToString())
            ?? throw new InvalidOperationException("Expected the persisted synthetic account.");
        await Assert.That(await reopenedManager.CheckPasswordAsync(persisted, TestPassword)).IsTrue();
        await Assert.That(await reopenedManager.CheckPasswordAsync(persisted, "Wrong1!")).IsFalse();
        await Assert.That(persisted.IsActive).IsFalse();
        await Assert.That(persisted.MustChangePassword).IsFalse();
        await Assert.That(persisted.AccessFailedCount).IsEqualTo(2);
        await Assert.That(persisted.LockoutEnd).IsEqualTo((DateTimeOffset?)lockout);
        await Assert.That(persisted.LockoutEnd?.Offset).IsEqualTo((TimeSpan?)TimeSpan.Zero);
        await Assert.That(!string.IsNullOrEmpty(persisted.SecurityStamp) && persisted.SecurityStamp != originalStamp).IsTrue();
        await Assert.That(!string.IsNullOrEmpty(persisted.ConcurrencyStamp)).IsTrue();
        await Assert.That(await reopenedManager.IsInRoleAsync(persisted, ApplicationRoles.Creator)).IsTrue();
    }

    [Test]
    public async Task Database_SecondGlobalRoleForUser_IsDeniedByUniqueIndex()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var user = await CreateUserAsync(scope.ServiceProvider, "one-role");
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        await RequireSuccessAsync(await manager.AddToRoleAsync(user, ApplicationRoles.Creator));
        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () =>
            await manager.AddToRoleAsync(user, ApplicationRoles.Educator));
        await AssertDatabaseFailureAsync(exception, PostgresErrorCodes.UniqueViolation);
        await using var verification = fixture.Services.CreateAsyncScope();
        await Assert.That(await verification.ServiceProvider.GetRequiredService<ApplicationDbContext>().UserRoles.CountAsync())
            .IsEqualTo(1);
    }

    [Test]
    public async Task Database_SecondOrganizationForUser_IsDeniedByUniqueIndex()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var user = await CreateUserAsync(scope.ServiceProvider, "one-organization");
        await RequireSuccessAsync(await scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>()
            .AddToRoleAsync(user, ApplicationRoles.Creator));
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var first = new Organization { Id = Guid.NewGuid(), Name = "First" };
        var second = new Organization { Id = Guid.NewGuid(), Name = "Second" };
        database.Organizations.AddRange(first, second);
        await database.SaveChangesAsync();
        database.OrganizationMemberships.Add(new OrganizationMembership
        {
            OrganizationId = first.Id,
            UserId = user.Id,
            RoleId = ApplicationRoles.CreatorId,
        });
        await database.SaveChangesAsync();
        database.OrganizationMemberships.Add(new OrganizationMembership
        {
            OrganizationId = second.Id,
            UserId = user.Id,
            RoleId = ApplicationRoles.CreatorId,
        });
        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
        await AssertDatabaseFailureAsync(exception, PostgresErrorCodes.UniqueViolation);
        await using var verification = fixture.Services.CreateAsyncScope();
        await Assert.That(await verification.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .OrganizationMemberships.CountAsync()).IsEqualTo(1);
    }

    [Test]
    [Arguments("missing-organization", PostgresErrorCodes.ForeignKeyViolation)]
    [Arguments("mismatched-role", PostgresErrorCodes.ForeignKeyViolation)]
    [Arguments("administrator", PostgresErrorCodes.CheckViolation)]
    public async Task Database_InvalidMembership_IsDeniedByTheDatabase(string scenario, string expectedCode)
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        await using var scope = fixture.Services.CreateAsyncScope();
        var user = await CreateUserAsync(scope.ServiceProvider, "invalid-membership");
        var manager = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        await RequireSuccessAsync(await manager.AddToRoleAsync(user,
            scenario == "administrator" ? ApplicationRoles.Administrator : ApplicationRoles.Creator));
        var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var organization = new Organization { Id = Guid.NewGuid(), Name = "Synthetic school" };
        database.Organizations.Add(organization);
        await database.SaveChangesAsync();
        database.OrganizationMemberships.Add(new OrganizationMembership
        {
            OrganizationId = scenario == "missing-organization" ? Guid.NewGuid() : organization.Id,
            UserId = user.Id,
            RoleId = scenario switch
            {
                "administrator" => ApplicationRoles.AdministratorId,
                "mismatched-role" => ApplicationRoles.EducatorId,
                _ => ApplicationRoles.CreatorId,
            },
        });
        var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
        await AssertDatabaseFailureAsync(exception, expectedCode);
        await using var verification = fixture.Services.CreateAsyncScope();
        await Assert.That(await verification.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .OrganizationMemberships.CountAsync()).IsEqualTo(0);
    }

    [Test]
    public async Task Database_ReferencedOrganizationDeletion_IsDeniedWithoutDeletingMembership()
    {
        await using var fixture = await PostgresAccountFixture.CreateAsync();
        Guid organizationId;
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var user = await CreateUserAsync(scope.ServiceProvider, "referenced-organization");
            await RequireSuccessAsync(await scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>()
                .AddToRoleAsync(user, ApplicationRoles.Educator));
            var database = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var organization = new Organization { Id = Guid.NewGuid(), Name = "Referenced school" };
            organizationId = organization.Id;
            database.Organizations.Add(organization);
            database.OrganizationMemberships.Add(new OrganizationMembership
            {
                OrganizationId = organization.Id,
                UserId = user.Id,
                RoleId = ApplicationRoles.EducatorId,
            });
            await database.SaveChangesAsync();
        }

        await using (var deletion = fixture.Services.CreateAsyncScope())
        {
            var database = deletion.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            database.Organizations.Remove(await database.Organizations.SingleAsync(record => record.Id == organizationId));
            var exception = await Assert.ThrowsAsync<DbUpdateException>(async () => await database.SaveChangesAsync());
            await AssertDatabaseFailureAsync(exception, PostgresErrorCodes.RestrictViolation);
        }

        await using var verification = fixture.Services.CreateAsyncScope();
        var verifiedDatabase = verification.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await Assert.That(await verifiedDatabase.Organizations.CountAsync()).IsEqualTo(1);
        await Assert.That(await verifiedDatabase.OrganizationMemberships.CountAsync()).IsEqualTo(1);
    }

    private static async Task<ApplicationUser> CreateUserAsync(IServiceProvider services, string name)
    {
        var user = new ApplicationUser { Id = Guid.NewGuid(), UserName = name };
        await RequireSuccessAsync(await services.GetRequiredService<UserManager<ApplicationUser>>().CreateAsync(user, TestPassword));
        return user;
    }

    private static async Task RequireSuccessAsync(IdentityResult result)
    {
        await Assert.That(result.Succeeded).IsTrue();
    }

    private static async Task AssertDatabaseFailureAsync(DbUpdateException? exception, string sqlState)
    {
        var postgresException = exception?.InnerException as PostgresException
            ?? throw new InvalidOperationException("Expected a PostgreSQL constraint failure.");
        await Assert.That(postgresException.SqlState).IsEqualTo(sqlState);
    }
}
