using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddAssetRemovalReceipts : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "asset_removal_receipts",
            columns: table => new
            {
                actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                asset_id = table.Column<Guid>(type: "uuid", nullable: false),
                applied = table.Column<bool>(type: "boolean", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_asset_removal_receipts", x => new { x.actor_id, x.operation_id });
                table.ForeignKey(
                    name: "FK_asset_removal_receipts_AspNetUsers_actor_id",
                    column: x => x.actor_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_asset_removal_receipts_asset_candidates_asset_id",
                    column: x => x.asset_id,
                    principalTable: "asset_candidates",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_asset_removal_receipts_asset_id",
            table: "asset_removal_receipts",
            column: "asset_id");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "asset_removal_receipts");
    }
}
