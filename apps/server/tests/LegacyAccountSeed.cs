using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;

namespace Spatia.Server.Tests;

// Upgrade fixtures seed the historical schema without using today's account projection.
internal static class LegacyAccountSeed
{
    public static Task InsertAsync(ApplicationDbContext database, ApplicationUser user) => database.Database.ExecuteSqlInterpolatedAsync($"""
        INSERT INTO "AspNetUsers" ("Id", "UserName", "NormalizedUserName", "IsActive", "MustChangePassword",
            "EmailConfirmed", "PhoneNumberConfirmed", "TwoFactorEnabled", "LockoutEnabled", "AccessFailedCount",
            "PasswordHash", "SecurityStamp", "ConcurrencyStamp")
        VALUES ({user.Id}, {user.UserName}, {user.NormalizedUserName ?? user.UserName!.ToUpperInvariant()},
            {user.IsActive}, {user.MustChangePassword}, false, false, false, {user.LockoutEnabled}, 0,
            {user.PasswordHash}, {user.SecurityStamp}, {user.ConcurrencyStamp})
        """);
}
