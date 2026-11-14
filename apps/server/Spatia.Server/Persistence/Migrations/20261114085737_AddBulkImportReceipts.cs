using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddBulkImportReceipts : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "bulk_import_receipts",
            columns: table => new
            {
                actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                protected_intent = table.Column<byte[]>(type: "bytea", nullable: true),
                created_accounts = table.Column<string>(type: "jsonb", nullable: false),
                protected_handoff = table.Column<byte[]>(type: "bytea", nullable: true),
                expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                acknowledged = table.Column<bool>(type: "boolean", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_bulk_import_receipts", x => new { x.actor_id, x.organization_id, x.operation_id });
                table.CheckConstraint("CK_bulk_import_receipt_abandoned", "protected_intent IS NOT NULL OR (created_accounts = '[]'::jsonb AND protected_handoff IS NULL AND NOT acknowledged)");
                table.CheckConstraint("CK_bulk_import_receipt_acknowledged", "NOT acknowledged OR protected_handoff IS NULL");
                table.CheckConstraint("CK_bulk_import_receipt_created", "jsonb_typeof(created_accounts) = 'array' AND jsonb_array_length(created_accounts) <= 200");
                table.ForeignKey(
                    name: "FK_bulk_import_receipts_AspNetUsers_actor_id",
                    column: x => x.actor_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_bulk_import_receipts_organizations_organization_id",
                    column: x => x.organization_id,
                    principalTable: "organizations",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_bulk_import_receipts_expires_at",
            table: "bulk_import_receipts",
            column: "expires_at",
            filter: "protected_handoff IS NOT NULL");

        migrationBuilder.CreateIndex(
            name: "IX_bulk_import_receipts_organization_id",
            table: "bulk_import_receipts",
            column: "organization_id");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "bulk_import_receipts");
    }
}
