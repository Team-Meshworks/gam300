using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Spatia.Server.Persistence;

/// <summary>
/// Creates database contexts for Entity Framework tooling from private environment configuration
/// </summary>
public sealed class ApplicationDbContextFactory : IDesignTimeDbContextFactory<ApplicationDbContext>
{
    /// <summary>
    /// Creates a PostgreSQL context using the <c>ConnectionStrings__Spatia</c> environment variable
    /// </summary>
    /// <param name="args">Arguments supplied by Entity Framework tooling, currently unused</param>
    /// <returns>A configured database context owned by the caller</returns>
    /// <exception cref="InvalidOperationException">
    /// The connection string environment variable is missing or blank
    /// </exception>
    public ApplicationDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ConnectionStrings__Spatia");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("Set ConnectionStrings__Spatia before running database tooling.");
        }

        var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseNpgsql(connectionString).Options;
        return new ApplicationDbContext(options);
    }
}
