using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Accounts;

namespace Spatia.Server.Persistence;

internal sealed class LegacyCreationBindingConfiguration : IEntityTypeConfiguration<LegacyCreationBinding>
{
    public void Configure(EntityTypeBuilder<LegacyCreationBinding> entity)
    {
        entity.ToTable("legacy_creation_bindings", table =>
        {
            table.HasCheckConstraint("CK_legacy_creation_bindings_kind", "kind IN ('project', 'duplicate', 'class')");
            table.HasCheckConstraint("CK_legacy_creation_bindings_digest", "octet_length(intent_digest) = 32");
            table.HasCheckConstraint("CK_legacy_creation_bindings_purpose", "purpose IN ('project', 'class', 'duplicate', 'import')");
        });
        entity.HasKey(row => new { row.ActorId, row.IntentDigest });
        entity.Property(row => row.ActorId).HasColumnName("actor_id");
        entity.Property(row => row.IntentDigest).HasColumnName("intent_digest");
        entity.Property(row => row.Kind).HasColumnName("kind").HasMaxLength(9);
        entity.Property(row => row.Purpose).HasColumnName("purpose").HasMaxLength(17);
        entity.Property(row => row.OrganizationId).HasColumnName("organization_id");
        entity.Property(row => row.SourceProjectId).HasColumnName("source_project_id");
        // Keep the binding after resource deletion so a delayed request cannot create a replacement
        entity.Property(row => row.ResourceId).HasColumnName("resource_id");
        entity.Property(row => row.OperationId).HasColumnName("operation_id");
        entity.Property(row => row.PreviousOperationId).HasColumnName("previous_operation_id");
        entity.HasOne<ApplicationUser>().WithMany().HasForeignKey(row => row.ActorId).OnDelete(DeleteBehavior.Cascade);
    }
}
