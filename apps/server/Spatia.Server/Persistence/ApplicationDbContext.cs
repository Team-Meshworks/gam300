using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;
using Spatia.Server.Classes;
using Spatia.Server.Projects;
using Spatia.Server.Publications;
using Spatia.Server.Reviews;

namespace Spatia.Server.Persistence;

/// <summary>
/// Stores accounts, organizations, project drafts with access assignments and immutable publication editions
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
    /// Gets the durable acknowledgements of accepted project save mutations
    /// </summary>
    public DbSet<ProjectSaveReceipt> ProjectSaveReceipts => Set<ProjectSaveReceipt>();

    /// <summary>
    /// Gets the account permissions assigned to individual projects
    /// </summary>
    public DbSet<ProjectAssignment> ProjectAssignments => Set<ProjectAssignment>();

    /// <summary>Gets private candidates and retained approved asset versions</summary>
    public DbSet<AssetCandidate> AssetCandidates => Set<AssetCandidate>();
    /// <summary>Gets organization-owned classes.</summary>
    public DbSet<Classroom> Classrooms => Set<Classroom>();

    /// <summary>Gets retained educator and student class memberships.</summary>
    public DbSet<ClassroomMember> ClassroomMembers => Set<ClassroomMember>();

    /// <summary>Gets server-owned class assignment metadata.</summary>
    public DbSet<ClassAssignment> ClassAssignments => Set<ClassAssignment>();

    /// <summary>Gets the independent student drafts for class assignments.</summary>
    public DbSet<ClassAssignmentStudent> ClassAssignmentStudents => Set<ClassAssignmentStudent>();

    /// <summary>Gets established project origins; absent origins are unverified.</summary>
    public DbSet<ProjectProvenance> ProjectProvenances => Set<ProjectProvenance>();

    /// <summary>Gets immutable private student submission evidence.</summary>
    public DbSet<ReviewSubmission> ReviewSubmissions => Set<ReviewSubmission>();

    /// <summary>Gets the append-only educator review decisions.</summary>
    public DbSet<ReviewDecision> ReviewDecisions => Set<ReviewDecision>();

    /// <summary>Gets educator comments on student work in progress.</summary>
    public DbSet<ProgressReview> ProgressReviews => Set<ProgressReview>();

    /// <summary>
    /// Gets immutable publication editions; current audience and lifecycle authorization are checked separately
    /// </summary>
    public DbSet<Publication> Publications => Set<Publication>();

    // Store access separately so hiding or revocation never rewrites a captured edition
    public DbSet<PublicationAccessState> PublicationAccess => Set<PublicationAccessState>();

    /// <summary>
    /// Configures account, project, asset and publication mappings with their independent retention constraints
    /// </summary>
    /// <param name="builder">The model builder receiving the database mappings</param>
    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.ApplyConfiguration(new AssetCandidateConfiguration());
        builder.ApplyConfiguration(new PublicationConfiguration());
        builder.Entity<ProgressReview>(review =>
        {
            review.ToTable("progress_reviews", table =>
            {
                table.HasCheckConstraint("CK_progress_reviews_feedback", "length(feedback) BETWEEN 1 AND 4000");
                table.HasCheckConstraint("CK_progress_reviews_revision", $"revision BETWEEN 0 AND {Project.MaxRevision}");
            });
            review.HasKey(row => row.Id);
            review.Property(row => row.Id).HasColumnName("id");
            review.Property(row => row.ProjectId).HasColumnName("project_id");
            review.Property(row => row.EducatorId).HasColumnName("educator_id");
            review.Property(row => row.Revision).HasColumnName("revision");
            review.Property(row => row.Feedback).HasColumnName("feedback").HasMaxLength(4000).IsRequired();
            review.Property(row => row.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("statement_timestamp()");
            review.HasIndex(row => new { row.ProjectId, row.Id });
            review.HasOne<Project>().WithMany().HasForeignKey(row => row.ProjectId).OnDelete(DeleteBehavior.Restrict);
            review.HasOne<ApplicationUser>().WithMany().HasForeignKey(row => row.EducatorId).OnDelete(DeleteBehavior.Restrict);
        });
        builder.Entity<PublicationAccessState>(policy =>
        {
            policy.ToTable("publication_access");
            policy.HasKey(row => row.PublicationId);
            policy.HasOne<Publication>().WithOne().HasForeignKey<PublicationAccessState>(row => row.PublicationId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ApplicationUser>(user =>
        {
            user.Property(account => account.UserName).IsRequired();
            user.Property(account => account.NormalizedUserName).IsRequired();
            user.Property(account => account.DisplayName).HasMaxLength(256);
            user.Property(account => account.IsDeleted).IsRequired();
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
            membership.HasAlternateKey(record => new { record.OrganizationId, record.UserId, record.RoleId });
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
                // The document boundary validates content before writes; this constraint also binds its stored metadata
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
            // Composite organization foreign keys are added by migration so EF can still update this property.
            project.HasIndex(record => new { record.Id, record.OrganizationId }).IsUnique();
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

        builder.Entity<ProjectSaveReceipt>(receipt =>
        {
            receipt.ToTable("project_save_receipts", table =>
            {
                table.HasCheckConstraint("CK_project_save_receipts_revision",
                    "expected_revision BETWEEN 0 AND 9007199254740990 AND revision = expected_revision + 1");
                table.HasCheckConstraint("CK_project_save_receipts_digest", "octet_length(request_digest) = 32");
                table.HasCheckConstraint("CK_project_save_receipts_saved_at", "isfinite(saved_at)");
            });
            receipt.HasKey(record => new { record.ProjectId, record.ClientMutationId });
            receipt.Property(record => record.ProjectId).HasColumnName("project_id");
            receipt.Property(record => record.ClientMutationId).HasColumnName("client_mutation_id");
            receipt.Property(record => record.ActorId).HasColumnName("actor_id");
            receipt.Property(record => record.ExpectedRevision).HasColumnName("expected_revision");
            receipt.Property(record => record.Revision).HasColumnName("revision");
            receipt.Property(record => record.RequestDigest).HasColumnName("request_digest").IsRequired();
            receipt.Property(record => record.SavedAt).HasColumnName("saved_at").HasColumnType("timestamp with time zone");
            receipt.HasIndex(record => new { record.ProjectId, record.Revision }).IsUnique();
            receipt.HasOne<Project>().WithMany().HasForeignKey(record => record.ProjectId).OnDelete(DeleteBehavior.Restrict);
            receipt.HasOne<ApplicationUser>().WithMany().HasForeignKey(record => record.ActorId).OnDelete(DeleteBehavior.Restrict);
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

        builder.Entity<Classroom>(classroom =>
        {
            classroom.ToTable("classrooms", table => table.HasCheckConstraint(
                "CK_classrooms_name", "length(btrim(name)) BETWEEN 1 AND 256"));
            classroom.HasKey(record => record.Id);
            classroom.HasAlternateKey(record => new { record.Id, record.OrganizationId });
            classroom.Property(record => record.Id).HasColumnName("id");
            classroom.Property(record => record.OrganizationId).HasColumnName("organization_id");
            classroom.Property(record => record.Name).HasColumnName("name").HasMaxLength(256).IsRequired();
            classroom.HasIndex(record => record.OrganizationId);
            classroom.HasOne<Organization>().WithMany()
                .HasForeignKey(record => record.OrganizationId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ClassroomMember>(member =>
        {
            member.ToTable("classroom_members", table => table.HasCheckConstraint(
                "CK_classroom_members_role_id",
                $"role_id IN ('{ApplicationRoles.EducatorId:D}'::uuid, '{ApplicationRoles.CreatorId:D}'::uuid)"));
            member.HasKey(record => new { record.ClassroomId, record.UserId });
            member.Property(record => record.ClassroomId).HasColumnName("classroom_id");
            member.Property(record => record.OrganizationId).HasColumnName("organization_id");
            member.Property(record => record.UserId).HasColumnName("user_id");
            member.Property(record => record.RoleId).HasColumnName("role_id");
            member.Property(record => record.IsActive).HasColumnName("active");
            member.HasIndex(record => new { record.UserId, record.IsActive, record.ClassroomId });
            member.HasOne<Classroom>().WithMany()
                .HasForeignKey(record => new { record.ClassroomId, record.OrganizationId })
                .HasPrincipalKey(record => new { record.Id, record.OrganizationId })
                .OnDelete(DeleteBehavior.Restrict);
            member.HasOne<OrganizationMembership>().WithMany()
                .HasForeignKey(record => new { record.OrganizationId, record.UserId, record.RoleId })
                .HasPrincipalKey(record => new { record.OrganizationId, record.UserId, record.RoleId })
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ClassAssignment>(assignment =>
        {
            assignment.ToTable("class_assignments", table =>
            {
                table.HasCheckConstraint("CK_class_assignments_title", "length(btrim(title)) BETWEEN 1 AND 256");
                table.HasCheckConstraint("CK_class_assignments_description", "length(btrim(description)) > 0");
                table.HasCheckConstraint("CK_class_assignments_instructions", "length(btrim(instructions)) > 0");
                table.HasCheckConstraint("CK_class_assignments_due", $"due_at_unix_seconds BETWEEN {ClassAssignment.MinimumUnixSeconds} AND {ClassAssignment.MaximumUnixSeconds}");
                table.HasCheckConstraint("CK_class_assignments_source_revision", $"source_revision BETWEEN 0 AND {Project.MaxRevision}");
                table.HasCheckConstraint("CK_class_assignments_request_digest", "octet_length(request_digest) = 32");
                table.HasCheckConstraint("CK_class_assignments_revision", $"revision BETWEEN 0 AND {Project.MaxRevision}");
                table.HasCheckConstraint("CK_class_assignments_last_edit", "(last_edit_id IS NULL AND last_edit_actor_id IS NULL AND last_edit_digest IS NULL) OR (last_edit_id IS NOT NULL AND last_edit_actor_id IS NOT NULL AND last_edit_digest IS NOT NULL AND octet_length(last_edit_digest) = 32)");
            });
            assignment.HasKey(record => record.Id);
            assignment.HasAlternateKey(record => new { record.Id, record.ClassroomId, record.OrganizationId });
            assignment.Property(record => record.Id).HasColumnName("id");
            assignment.Property(record => record.ClassroomId).HasColumnName("classroom_id");
            assignment.Property(record => record.OrganizationId).HasColumnName("organization_id");
            assignment.Property(record => record.CreatedByUserId).HasColumnName("created_by_user_id");
            assignment.Property(record => record.SourceProjectId).HasColumnName("source_project_id");
            assignment.Property(record => record.SourceRevision).HasColumnName("source_revision");
            assignment.Property(record => record.DueAtUnixSeconds).HasColumnName("due_at_unix_seconds");
            assignment.Property(record => record.Title).HasColumnName("title").HasMaxLength(256).IsRequired();
            assignment.Property(record => record.Description).HasColumnName("description").IsRequired();
            assignment.Property(record => record.Instructions).HasColumnName("instructions").IsRequired();
            assignment.Property(record => record.RequestDigest).HasColumnName("request_digest").IsRequired();
            assignment.Property(record => record.Revision).HasColumnName("revision");
            assignment.Property(record => record.LastEditId).HasColumnName("last_edit_id");
            assignment.Property(record => record.LastEditActorId).HasColumnName("last_edit_actor_id");
            assignment.Property(record => record.LastEditDigest).HasColumnName("last_edit_digest");
            assignment.HasIndex(record => new { record.ClassroomId, record.Id });
            assignment.HasOne<Classroom>().WithMany()
                .HasForeignKey(record => new { record.ClassroomId, record.OrganizationId })
                .HasPrincipalKey(record => new { record.Id, record.OrganizationId })
                .OnDelete(DeleteBehavior.Restrict);
            assignment.HasOne<Project>().WithMany()
                .HasForeignKey(record => record.SourceProjectId)
                .OnDelete(DeleteBehavior.Restrict);
            assignment.HasOne<ApplicationUser>().WithMany()
                .HasForeignKey(record => record.CreatedByUserId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ClassAssignmentStudent>(student =>
        {
            student.ToTable("class_assignment_students", table => table.HasCheckConstraint(
                "CK_class_assignment_students_role_id", $"role_id = '{ApplicationRoles.CreatorId:D}'::uuid"));
            student.HasKey(record => new { record.AssignmentId, record.StudentId });
            student.HasAlternateKey(record => new { record.AssignmentId, record.StudentId, record.OrganizationId });
            student.HasAlternateKey(record => new { record.ProjectId, record.StudentId });
            student.Property(record => record.AssignmentId).HasColumnName("assignment_id");
            student.Property(record => record.ClassroomId).HasColumnName("classroom_id");
            student.Property(record => record.OrganizationId).HasColumnName("organization_id");
            student.Property(record => record.StudentId).HasColumnName("student_id");
            student.Property(record => record.RoleId).HasColumnName("role_id");
            student.Property(record => record.ProjectId).HasColumnName("project_id");
            student.Property(record => record.IsActive).HasColumnName("is_active").HasDefaultValue(true).HasSentinel(true);
            student.Property(record => record.OriginallyAssigned).HasColumnName("originally_assigned").HasDefaultValue(true).HasSentinel(true);
            student.HasIndex(record => record.ProjectId).IsUnique();
            student.HasIndex(record => new { record.StudentId, record.AssignmentId });
            student.HasOne<ClassAssignment>().WithMany()
                .HasForeignKey(record => new { record.AssignmentId, record.ClassroomId, record.OrganizationId })
                .HasPrincipalKey(record => new { record.Id, record.ClassroomId, record.OrganizationId })
                .OnDelete(DeleteBehavior.Restrict);
            student.HasOne<ClassroomMember>().WithMany()
                .HasForeignKey(record => new { record.ClassroomId, UserId = record.StudentId })
                .HasPrincipalKey(record => new { record.ClassroomId, record.UserId })
                .OnDelete(DeleteBehavior.Restrict);
            student.HasOne<OrganizationMembership>().WithMany()
                .HasForeignKey(record => new { record.OrganizationId, UserId = record.StudentId, record.RoleId })
                .HasPrincipalKey(record => new { record.OrganizationId, record.UserId, record.RoleId })
                .OnDelete(DeleteBehavior.Restrict);
            student.HasOne<Project>().WithMany()
                .HasForeignKey(record => record.ProjectId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ProjectProvenance>(origin =>
        {
            origin.ToTable("project_provenance", table => table.HasCheckConstraint("CK_project_provenance_kind", """
                (kind = 'ordinary' AND class_assignment_id IS NULL AND student_id IS NULL)
                OR (kind = 'class' AND class_assignment_id IS NOT NULL AND student_id IS NOT NULL)
                """));
            origin.HasKey(record => record.ProjectId);
            origin.Property(record => record.ProjectId).HasColumnName("project_id");
            origin.Property(record => record.OrganizationId).HasColumnName("organization_id");
            origin.Property(record => record.Kind).HasColumnName("kind").HasMaxLength(16).IsRequired();
            origin.Property(record => record.ClassAssignmentId).HasColumnName("class_assignment_id");
            origin.Property(record => record.StudentId).HasColumnName("student_id");
            origin.HasOne<Project>().WithMany()
                .HasForeignKey(record => record.ProjectId)
                .OnDelete(DeleteBehavior.Restrict);
            origin.HasOne<ClassAssignmentStudent>().WithMany()
                .HasForeignKey(record => new { AssignmentId = record.ClassAssignmentId, record.StudentId, record.OrganizationId })
                .HasPrincipalKey(record => new { record.AssignmentId, record.StudentId, record.OrganizationId })
                .OnDelete(DeleteBehavior.Restrict);
        });
        builder.ApplyConfiguration(new ReviewSubmissionConfiguration());
        builder.ApplyConfiguration(new ReviewDecisionConfiguration());
    }
}
