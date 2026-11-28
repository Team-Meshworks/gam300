using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Spatia.Server.Assets;

namespace Spatia.Server.Persistence;

public sealed class AssetTagConfiguration : IEntityTypeConfiguration<AssetTag>
{
    // A fixed seed time keeps the starter rows identical in every migration and model snapshot
    private static readonly DateTimeOffset Seeded = new(2026, 11, 27, 0, 0, 0, TimeSpan.Zero);

    public void Configure(EntityTypeBuilder<AssetTag> entity)
    {
        entity.ToTable("asset_tags", table =>
            table.HasCheckConstraint("CK_asset_tag_name", $"length(name) BETWEEN 1 AND {AssetTags.MaxLength} AND length(key) BETWEEN 1 AND {AssetTags.MaxLength}"));
        // The comparison key is the identity, so "Post war" can never be created beside "Post-war"
        entity.HasKey(tag => tag.Key);
        entity.Property(tag => tag.Key).HasColumnName("key").HasMaxLength(AssetTags.MaxLength);
        entity.Property(tag => tag.Name).HasColumnName("name").HasMaxLength(AssetTags.MaxLength);
        entity.Property(tag => tag.CreatedBy).HasColumnName("created_by");
        entity.Property(tag => tag.CreatedAt).HasColumnName("created_at");
        entity.HasOne<Spatia.Server.Accounts.ApplicationUser>().WithMany().HasForeignKey(tag => tag.CreatedBy).OnDelete(DeleteBehavior.SetNull);
        entity.HasData(AssetTags.Starter.Select(name => new AssetTag { Key = AssetTags.Key(name), Name = name, CreatedAt = Seeded }));
    }
}
