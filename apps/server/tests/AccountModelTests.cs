using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

[NotInParallel]
public sealed class AccountModelTests
{
    [Test]
    public async Task Model_DesignTimeAndDependencyInjection_UseTheSameIdentitySchema()
    {
        const string connection = "Host=127.0.0.1;Database=spatia_scrum45_test;Username=spatia_test";
        var previous = Environment.GetEnvironmentVariable("ConnectionStrings__Spatia");
        Environment.SetEnvironmentVariable("ConnectionStrings__Spatia", connection);
        try
        {
            using var designContext = new ApplicationDbContextFactory().CreateDbContext([]);
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSpatiaAccounts(connection);
            await using var provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true });
            await using var scope = provider.CreateAsyncScope();
            var runtimeContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

            await Assert.That(runtimeContext.Model.ToDebugString(MetadataDebugStringOptions.LongDefault))
                .IsEqualTo(designContext.Model.ToDebugString(MetadataDebugStringOptions.LongDefault));
            await Assert.That(runtimeContext.Model.FindEntityType(typeof(IdentityUserClaim<Guid>))!
                .FindProperty(nameof(IdentityUserClaim<Guid>.Id))!.ClrType).IsEqualTo(typeof(int));
            await Assert.That(runtimeContext.Model.FindEntityType(typeof(IdentityRoleClaim<Guid>))!
                .FindProperty(nameof(IdentityRoleClaim<Guid>.Id))!.ClrType).IsEqualTo(typeof(int));
            await Assert.That(runtimeContext.Model.GetEntityTypes().Any(entity => entity.GetTableName() == "AspNetUserPasskeys"))
                .IsFalse();
            await Assert.That(new ApplicationUser().IsActive).IsTrue();
            await Assert.That(new ApplicationUser().MustChangePassword).IsTrue();
        }
        finally
        {
            Environment.SetEnvironmentVariable("ConnectionStrings__Spatia", previous);
        }
    }

    [Test]
    public async Task DesignTimeFactory_MissingConfiguration_RejectsWithoutConnecting()
    {
        var previous = Environment.GetEnvironmentVariable("ConnectionStrings__Spatia");
        Environment.SetEnvironmentVariable("ConnectionStrings__Spatia", null);
        try
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                using var context = new ApplicationDbContextFactory().CreateDbContext([]);
                return Task.CompletedTask;
            });
        }
        finally
        {
            Environment.SetEnvironmentVariable("ConnectionStrings__Spatia", previous);
        }
    }

    [Test]
    [Arguments("Host=example.invalid;Database=spatia_scrum45_test")]
    [Arguments("Host=127.0.0.1;Database=postgres")]
    [Arguments("Host=127.0.0.1,example.invalid;Database=spatia_scrum45_test")]
    [Arguments("Host=127.0.0.1;Database=spatia_scrum45_test;UnknownSetting=true")]
    public async Task Fixture_UnsafeDatabaseTarget_RejectsBeforeConnecting(string connection)
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            PostgresAccountFixture.ValidateConnectionString(connection);
            return Task.CompletedTask;
        });
    }
}
