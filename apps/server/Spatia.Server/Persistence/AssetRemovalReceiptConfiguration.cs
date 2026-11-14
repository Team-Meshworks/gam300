using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Accounts;
using Spatia.Server.Assets;

namespace Spatia.Server.Persistence;

internal sealed class AssetRemovalReceiptConfiguration : IEntityTypeConfiguration<AssetRemovalReceipt>
{
    public void Configure(EntityTypeBuilder<AssetRemovalReceipt> entity)
    {
        entity.ToTable("asset_removal_receipts");
        entity.HasKey(row => new { row.ActorId, row.OperationId });
        entity.Property(row => row.ActorId).HasColumnName("actor_id");
        entity.Property(row => row.OperationId).HasColumnName("operation_id");
        entity.Property(row => row.AssetId).HasColumnName("asset_id");
        entity.Property(row => row.Applied).HasColumnName("applied");
        entity.HasOne<ApplicationUser>().WithMany().HasForeignKey(row => row.ActorId).OnDelete(DeleteBehavior.Cascade);
        entity.HasOne<AssetCandidate>().WithMany().HasForeignKey(row => row.AssetId).OnDelete(DeleteBehavior.Cascade);
    }
}
