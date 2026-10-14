using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;

namespace Spatia.Server.Persistence;

public sealed class ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
    : IdentityDbContext<ApplicationUser, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<Organization> Organizations => Set<Organization>();

    public DbSet<OrganizationMembership> OrganizationMemberships => Set<OrganizationMembership>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<ApplicationUser>(user =>
        {
            user.Property(account => account.UserName).IsRequired();
            user.Property(account => account.NormalizedUserName).IsRequired();
        });

        builder.Entity<IdentityRole<Guid>>().HasData(
            new IdentityRole<Guid>
            {
                Id = ApplicationRoles.AdministratorId,
                Name = ApplicationRoles.Administrator,
                NormalizedName = "ADMINISTRATOR",
                ConcurrencyStamp = "7e815748-1cd1-4018-b4b8-0e578f5508cd",
            },
            new IdentityRole<Guid>
            {
                Id = ApplicationRoles.EducatorId,
                Name = ApplicationRoles.Educator,
                NormalizedName = "EDUCATOR",
                ConcurrencyStamp = "d14c51b6-510a-4430-a27c-bfdc6e9d801b",
            },
            new IdentityRole<Guid>
            {
                Id = ApplicationRoles.CreatorId,
                Name = ApplicationRoles.Creator,
                NormalizedName = "CREATOR",
                ConcurrencyStamp = "862d776c-4d56-4dd8-919d-26044b6d8a44",
            });

        builder.Entity<IdentityUserRole<Guid>>().HasIndex(role => role.UserId).IsUnique();

        builder.Entity<Organization>(organization =>
        {
            organization.ToTable("organizations");
            organization.HasKey(record => record.Id);
            organization.Property(record => record.Id).HasColumnName("id");
            organization.Property(record => record.Name).HasColumnName("name").HasMaxLength(256).IsRequired();
            organization.Property(record => record.IsActive).HasColumnName("active");
        });

        builder.Entity<OrganizationMembership>(membership =>
        {
            membership.ToTable("organization_memberships", table => table.HasCheckConstraint(
                "CK_organization_memberships_role_id",
                $"role_id IN ('{ApplicationRoles.EducatorId:D}'::uuid, '{ApplicationRoles.CreatorId:D}'::uuid)"));
            membership.HasKey(record => new { record.OrganizationId, record.UserId });
            membership.Property(record => record.OrganizationId).HasColumnName("organization_id");
            membership.Property(record => record.UserId).HasColumnName("user_id");
            membership.Property(record => record.RoleId).HasColumnName("role_id");
            membership.HasIndex(record => record.UserId).IsUnique();
            membership.HasOne<Organization>().WithMany()
                .HasForeignKey(record => record.OrganizationId)
                .OnDelete(DeleteBehavior.Restrict);
            membership.HasOne<IdentityUserRole<Guid>>().WithMany()
                .HasForeignKey(record => new { record.UserId, record.RoleId })
                .OnDelete(DeleteBehavior.Restrict);
        });
    }
}
