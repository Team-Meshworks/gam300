using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Projects;

namespace Spatia.Server.Persistence;

/// <summary>
/// Stores Identity accounts, organization memberships and project drafts with their access assignments
/// </summary>
/// <param name="options">The database provider and context configuration</param>
public sealed class ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
    : IdentityDbContext<ApplicationUser, IdentityRole<Guid>, Guid>(options)
{
    /// <summary>
    /// Gets the organizations available for account membership
    /// </summary>
    public DbSet<Organization> Organizations => Set<Organization>();

    /// <summary>
    /// Gets the organization and role memberships for educators and creators
    /// </summary>
    public DbSet<OrganizationMembership> OrganizationMemberships => Set<OrganizationMembership>();

    /// <summary>
    /// Gets the persisted project drafts and their revision metadata
    /// </summary>
    public DbSet<Project> Projects => Set<Project>();

    /// <summary>
    /// Gets the account permissions assigned to individual projects
    /// </summary>
    public DbSet<ProjectAssignment> ProjectAssignments => Set<ProjectAssignment>();

    /// <summary>
    /// Configures account, organization and project mappings, constraints and fixed role seeds
    /// </summary>
    /// <param name="builder">The model builder receiving the database mappings</param>
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

        builder.Entity<Project>(project =>
        {
            project.ToTable("projects", table =>
            {
                table.HasCheckConstraint("CK_projects_revision", "revision BETWEEN 0 AND 9007199254740991");
                table.HasCheckConstraint("CK_projects_schema_version", "schema_version > 0");
                // TODO: Apply SCRUM-50 supported-version and field/reference validation before writes; this check only binds metadata
                table.HasCheckConstraint("CK_projects_document", """
                    (
                        jsonb_typeof(document) = 'object'
                        AND jsonb_typeof(document -> 'projectId') = 'string'
                        AND lower(document ->> 'projectId') = id::text
                        AND jsonb_typeof(document -> 'schemaVersion') = 'number'
                        AND document -> 'schemaVersion' = to_jsonb(schema_version)
                    ) IS TRUE
                    """);
                table.HasCheckConstraint("CK_projects_updated_at", "isfinite(updated_at)");
                table.HasCheckConstraint("CK_projects_last_mutation", """
                    (last_mutation_actor_id IS NULL AND last_mutation_id IS NULL AND last_mutation_digest IS NULL)
                    OR (last_mutation_actor_id IS NOT NULL AND last_mutation_id IS NOT NULL
                        AND last_mutation_digest IS NOT NULL AND octet_length(last_mutation_digest) = 32)
                    """);
            });
            project.HasKey(record => record.Id);
            project.Property(record => record.Id).HasColumnName("id");
            project.Property(record => record.OrganizationId).HasColumnName("organization_id");
            project.Property(record => record.IsArchived).HasColumnName("archived");
            project.Property(record => record.Revision).HasColumnName("revision").IsConcurrencyToken();
            project.Property(record => record.SchemaVersion).HasColumnName("schema_version");
            project.Property(record => record.DocumentJson).HasColumnName("document").HasColumnType("jsonb").IsRequired();
            project.Property(record => record.UpdatedAt).HasColumnName("updated_at").HasColumnType("timestamp with time zone");
            project.Property(record => record.LastMutationActorId).HasColumnName("last_mutation_actor_id");
            project.Property(record => record.LastMutationId).HasColumnName("last_mutation_id");
            project.Property(record => record.LastMutationDigest).HasColumnName("last_mutation_digest");
            project.HasIndex(record => new { record.OrganizationId, record.IsArchived });
            project.HasOne<Organization>().WithMany()
                .HasForeignKey(record => record.OrganizationId)
                .OnDelete(DeleteBehavior.Restrict);
            project.HasOne<ApplicationUser>().WithMany()
                .HasForeignKey(record => record.LastMutationActorId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ProjectAssignment>(assignment =>
        {
            assignment.ToTable("project_assignments");
            assignment.HasKey(record => new { record.ProjectId, record.UserId });
            assignment.Property(record => record.ProjectId).HasColumnName("project_id");
            assignment.Property(record => record.UserId).HasColumnName("user_id");
            assignment.Property(record => record.CanEdit).HasColumnName("can_edit");
            assignment.Property(record => record.CanManage).HasColumnName("can_manage");
            assignment.Property(record => record.CanPublish).HasColumnName("can_publish");
            assignment.HasIndex(record => new { record.UserId, record.ProjectId });
            assignment.HasOne<Project>().WithMany()
                .HasForeignKey(record => record.ProjectId)
                .OnDelete(DeleteBehavior.Restrict);
            assignment.HasOne<ApplicationUser>().WithMany()
                .HasForeignKey(record => record.UserId)
                .OnDelete(DeleteBehavior.Restrict);
        });
    }
}
