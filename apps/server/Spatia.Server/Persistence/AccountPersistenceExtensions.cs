using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;

namespace Spatia.Server.Persistence;

/// <summary>
/// Registers PostgreSQL persistence and the Identity stores used by Spatia accounts
/// </summary>
public static class AccountPersistenceExtensions
{
    /// <summary>
    /// Adds the scoped PostgreSQL context, account roles and Entity Framework Identity stores
    /// </summary>
    /// <param name="services">The service collection receiving the persistence registrations</param>
    /// <param name="connectionString">The nonblank PostgreSQL connection string</param>
    /// <returns>The Identity builder for additional account configuration</returns>
    /// <exception cref="ArgumentNullException">The service collection or connection string is null</exception>
    /// <exception cref="ArgumentException">The connection string is empty or whitespace</exception>
    public static IdentityBuilder AddSpatiaAccounts(this IServiceCollection services, string connectionString)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionString);

        services.AddDbContext<ApplicationDbContext>(options => options.UseNpgsql(connectionString));
        return services.AddIdentityCore<ApplicationUser>()
            .AddRoles<IdentityRole<Guid>>()
            .AddEntityFrameworkStores<ApplicationDbContext>();
    }
}
