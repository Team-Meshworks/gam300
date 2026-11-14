using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Accounts;

namespace Spatia.Server.Persistence;

internal sealed class CreationReceiptConfiguration : IEntityTypeConfiguration<CreationReceipt>
{
    public void Configure(EntityTypeBuilder<CreationReceipt> entity)
    {
        entity.ToTable("creation_receipts", table =>
        {
            table.HasCheckConstraint("CK_creation_receipts_kind", "kind IN ('project', 'duplicate', 'class')");
            table.HasCheckConstraint("CK_creation_receipts_digest", "octet_length(request_digest) = 32");
            table.HasCheckConstraint("CK_creation_receipts_purpose", "purpose IN ('project', 'class', 'duplicate', 'import', 'assignment-source')");
        });
        entity.HasKey(row => new { row.ActorId, row.OperationId });
        entity.Property(row => row.ActorId).HasColumnName("actor_id");
        entity.Property(row => row.OperationId).HasColumnName("operation_id");
        entity.Property(row => row.Sequence).HasColumnName("sequence").UseIdentityByDefaultColumn();
        entity.Property(row => row.Purpose).HasColumnName("purpose").HasMaxLength(17).IsRequired();
        entity.Property(row => row.Acknowledged).HasColumnName("acknowledged").HasDefaultValue(false);
        entity.Property(row => row.SourceProjectId).HasColumnName("source_project_id");
        entity.HasIndex(row => row.Sequence).IsUnique();
        entity.HasIndex(row => new { row.ActorId, row.Purpose, row.Sequence });
        entity.HasIndex(row => new { row.ActorId, row.Purpose, row.Sequence }, "IX_creation_receipts_unacknowledged").HasFilter("NOT acknowledged");
        entity.Property(row => row.Kind).HasColumnName("kind").HasMaxLength(9);
        entity.Property(row => row.RequestDigest).HasColumnName("request_digest").IsRequired();
        entity.Property(row => row.ResourceId).HasColumnName("resource_id");
        entity.Property(row => row.ResponseJson).HasColumnName("response_json");
        entity.HasOne<ApplicationUser>().WithMany().HasForeignKey(row => row.ActorId).OnDelete(DeleteBehavior.Cascade);
    }
}
