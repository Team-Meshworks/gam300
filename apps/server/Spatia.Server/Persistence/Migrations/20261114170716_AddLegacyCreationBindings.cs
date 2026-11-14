using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

public partial class AddLegacyCreationBindings : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "legacy_creation_bindings",
            columns: table => new
            {
                actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                intent_digest = table.Column<byte[]>(type: "bytea", nullable: false),
                kind = table.Column<string>(type: "character varying(9)", maxLength: 9, nullable: false),
                purpose = table.Column<string>(type: "character varying(17)", maxLength: 17, nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                source_project_id = table.Column<Guid>(type: "uuid", nullable: true),
                resource_id = table.Column<Guid>(type: "uuid", nullable: false),
                operation_id = table.Column<Guid>(type: "uuid", nullable: true),
                previous_operation_id = table.Column<Guid>(type: "uuid", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_legacy_creation_bindings", x => new { x.actor_id, x.intent_digest });
                table.CheckConstraint("CK_legacy_creation_bindings_digest", "octet_length(intent_digest) = 32");
                table.CheckConstraint("CK_legacy_creation_bindings_kind", "kind IN ('project', 'duplicate', 'class')");
                table.CheckConstraint("CK_legacy_creation_bindings_purpose", "purpose IN ('project', 'class', 'duplicate', 'import')");
                table.ForeignKey(
                    name: "FK_legacy_creation_bindings_AspNetUsers_actor_id",
                    column: x => x.actor_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            LOCK TABLE legacy_creation_bindings IN ACCESS EXCLUSIVE MODE;
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM legacy_creation_bindings) THEN
                    RAISE EXCEPTION 'Legacy creation resolutions must be retained; review the downgrade first.';
                END IF;
            END $$;
            """);
        migrationBuilder.DropTable(
            name: "legacy_creation_bindings");
    }
}
