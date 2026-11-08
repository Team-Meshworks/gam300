using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261108150000_AddAudioAssets")]
public sealed class AddAudioAssets : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Extend the existing immutable asset table without changing existing entries
        migrationBuilder.DropCheckConstraint("CK_asset_candidate_kind", "asset_candidates");
        migrationBuilder.AddCheckConstraint("CK_asset_candidate_kind", "asset_candidates", "kind IN ('model', 'environment', 'audio')");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // PostgreSQL rejects rollback while audio rows exist instead of discarding retained assets
        migrationBuilder.DropCheckConstraint("CK_asset_candidate_kind", "asset_candidates");
        migrationBuilder.AddCheckConstraint("CK_asset_candidate_kind", "asset_candidates", "kind IN ('model', 'environment')");
    }
}
