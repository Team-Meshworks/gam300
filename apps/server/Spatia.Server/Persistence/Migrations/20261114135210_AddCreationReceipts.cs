using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

public partial class AddCreationReceipts : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "creation_receipts",
            columns: table => new
            {
                actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                kind = table.Column<string>(type: "character varying(9)", maxLength: 9, nullable: false),
                request_digest = table.Column<byte[]>(type: "bytea", nullable: false),
                resource_id = table.Column<Guid>(type: "uuid", nullable: false),
                response_json = table.Column<string>(type: "text", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_creation_receipts", x => new { x.actor_id, x.operation_id });
                table.CheckConstraint("CK_creation_receipts_digest", "octet_length(request_digest) = 32");
                table.CheckConstraint("CK_creation_receipts_kind", "kind IN ('project', 'duplicate', 'class')");
                table.ForeignKey(
                    name: "FK_creation_receipts_AspNetUsers_actor_id",
                    column: x => x.actor_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            LOCK TABLE creation_receipts IN ACCESS EXCLUSIVE MODE;
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM creation_receipts) THEN
                    RAISE EXCEPTION 'Creation receipt history must be retained; review the downgrade first.';
                END IF;
            END $$;
            """);
        migrationBuilder.DropTable(
            name: "creation_receipts");
    }
}
