using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Assets;

namespace Spatia.Server.Persistence;

/// <summary>Stores private candidates and retained approved versions in the existing application database</summary>
public sealed class AssetCandidateConfiguration : IEntityTypeConfiguration<AssetCandidate>
{
    public void Configure(EntityTypeBuilder<AssetCandidate> entity)
    {

        // Enforce lifecycle invariants in PostgreSQL as well as the request handlers
        entity.ToTable("asset_candidates", table =>
        {
            table.HasCheckConstraint("CK_asset_candidate_kind", "kind IN ('model', 'environment')");
            table.HasCheckConstraint("CK_asset_candidate_size", "octet_length(bytes) BETWEEN 1 AND 20971520");
            table.HasCheckConstraint("CK_asset_candidate_status", "status IN ('pending', 'approved', 'invalid')");
            table.HasCheckConstraint("CK_asset_candidate_retirement", "(NOT deleted OR hidden) AND (NOT removed_from_projects OR deleted)");
            table.HasCheckConstraint("CK_asset_candidate_approval", "status <> 'approved' OR (reviewed_by IS NOT NULL AND source IS NOT NULL AND license IS NOT NULL AND review_notes IS NOT NULL)");
        });
        entity.HasKey(asset => asset.Id);

        // Store stable identity, content fingerprint and bytes together rather than relying on a mutable file path
        entity.Property(asset => asset.Id).HasColumnName("id");
        entity.Property(asset => asset.Name).HasColumnName("name").HasMaxLength(120);
        entity.Property(asset => asset.Kind).HasColumnName("kind").HasMaxLength(16);
        entity.Property(asset => asset.Category).HasColumnName("category").HasMaxLength(40);
        entity.Property(asset => asset.Sha256).HasColumnName("sha256").HasMaxLength(64);
        entity.Property(asset => asset.Bytes).HasColumnName("bytes");

        // Keep technical validation separate from visibility and irreversible retirement flags
        entity.Property(asset => asset.Status).HasColumnName("status").HasMaxLength(16);
        entity.Property(asset => asset.ValidationJson).HasColumnName("validation").HasColumnType("jsonb");
        entity.Property(asset => asset.Hidden).HasColumnName("hidden");
        entity.Property(asset => asset.Deleted).HasColumnName("deleted");
        entity.Property(asset => asset.RemovedFromProjects).HasColumnName("removed_from_projects");

        // Keep the approval decision and actor identities with the exact retained version
        entity.Property(asset => asset.Source).HasColumnName("source").HasMaxLength(2000);
        entity.Property(asset => asset.License).HasColumnName("license").HasMaxLength(2000);
        entity.Property(asset => asset.ReviewNotes).HasColumnName("review_notes").HasMaxLength(2000);
        entity.Property(asset => asset.SubmittedBy).HasColumnName("submitted_by");
        entity.Property(asset => asset.ReviewedBy).HasColumnName("reviewed_by");
        entity.Property(asset => asset.CreatedAt).HasColumnName("created_at");

        // Match administrative library queries without indexing the retained binary payload
        entity.HasIndex(asset => new { asset.Kind, asset.Deleted, asset.Hidden });

        // Restrict account deletion while an immutable version still needs its audit identity
        entity.HasOne<Spatia.Server.Accounts.ApplicationUser>().WithMany().HasForeignKey(asset => asset.SubmittedBy).OnDelete(DeleteBehavior.Restrict);
        entity.HasOne<Spatia.Server.Accounts.ApplicationUser>().WithMany().HasForeignKey(asset => asset.ReviewedBy).OnDelete(DeleteBehavior.Restrict);
    }
}
