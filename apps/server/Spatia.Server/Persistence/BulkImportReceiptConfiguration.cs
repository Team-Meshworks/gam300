using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Accounts;

namespace Spatia.Server.Persistence;

internal sealed class BulkImportReceiptConfiguration : IEntityTypeConfiguration<BulkImportReceipt>
{
    public void Configure(EntityTypeBuilder<BulkImportReceipt> entity)
    {
        entity.ToTable("bulk_import_receipts", table =>
        {
            table.HasCheckConstraint("CK_bulk_import_receipt_created", "jsonb_typeof(created_accounts) = 'array' AND jsonb_array_length(created_accounts) <= 200");
            table.HasCheckConstraint("CK_bulk_import_receipt_abandoned", "protected_intent IS NOT NULL OR (created_accounts = '[]'::jsonb AND protected_handoff IS NULL AND NOT acknowledged)");
            table.HasCheckConstraint("CK_bulk_import_receipt_acknowledged", "NOT acknowledged OR protected_handoff IS NULL");
        });
        entity.HasKey(row => new { row.ActorId, row.OrganizationId, row.OperationId });
        entity.Property(row => row.ActorId).HasColumnName("actor_id");
        entity.Property(row => row.OrganizationId).HasColumnName("organization_id");
        entity.Property(row => row.OperationId).HasColumnName("operation_id");
        entity.Property(row => row.CreatedJson).HasColumnName("created_accounts").HasColumnType("jsonb");
        entity.Property(row => row.ProtectedIntent).HasColumnName("protected_intent");
        entity.Property(row => row.ProtectedHandoff).HasColumnName("protected_handoff");
        entity.Property(row => row.Acknowledged).HasColumnName("acknowledged");
        entity.Property(row => row.ExpiresAt).HasColumnName("expires_at");
        entity.HasIndex(row => row.ExpiresAt).HasFilter("protected_handoff IS NOT NULL");
        entity.HasOne<ApplicationUser>().WithMany().HasForeignKey(row => row.ActorId).OnDelete(DeleteBehavior.Cascade);
        entity.HasOne<Organization>().WithMany().HasForeignKey(row => row.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}
