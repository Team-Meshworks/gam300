using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

public partial class AddCreationGenerations : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<bool>(
            name: "acknowledged",
            table: "creation_receipts",
            type: "boolean",
            nullable: false,
            defaultValue: false);

        migrationBuilder.AddColumn<string>(
            name: "purpose",
            table: "creation_receipts",
            type: "character varying(17)",
            maxLength: 17,
            nullable: false,
            defaultValue: "");

        migrationBuilder.AddColumn<long>(
            name: "sequence",
            table: "creation_receipts",
            type: "bigint",
            nullable: false,
            defaultValue: 0L)
            .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn);

        migrationBuilder.AddColumn<Guid>(
            name: "source_project_id",
            table: "creation_receipts",
            type: "uuid",
            nullable: true);

        // Existing receipts lack creation order and source attribution, so preserve them without inventing either.
        migrationBuilder.Sql("""
            UPDATE creation_receipts SET purpose = kind;
            WITH ordered AS (
                SELECT actor_id, operation_id, row_number() OVER (ORDER BY actor_id, operation_id) AS position
                FROM creation_receipts
            )
            UPDATE creation_receipts r SET sequence = ordered.position FROM ordered
            WHERE r.actor_id = ordered.actor_id AND r.operation_id = ordered.operation_id;
            DO $$ BEGIN
                PERFORM setval(pg_get_serial_sequence('creation_receipts', 'sequence'),
                    COALESCE((SELECT max(sequence) FROM creation_receipts), 1), EXISTS (SELECT 1 FROM creation_receipts));
            END $$;
            ALTER TABLE creation_receipts ALTER COLUMN purpose DROP DEFAULT;
            """);

        migrationBuilder.CreateIndex(
            name: "IX_creation_receipts_actor_id_purpose_sequence",
            table: "creation_receipts",
            columns: new[] { "actor_id", "purpose", "sequence" });

        migrationBuilder.CreateIndex(
            name: "IX_creation_receipts_sequence",
            table: "creation_receipts",
            column: "sequence",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_creation_receipts_unacknowledged",
            table: "creation_receipts",
            columns: new[] { "actor_id", "purpose", "sequence" },
            filter: "NOT acknowledged");

        migrationBuilder.AddCheckConstraint(
            name: "CK_creation_receipts_purpose",
            table: "creation_receipts",
            sql: "purpose IN ('project', 'class', 'duplicate', 'import', 'assignment-source')");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM creation_receipts) THEN
                    RAISE EXCEPTION 'Creation generation history must be retained; review the downgrade first.';
                END IF;
            END $$;
            """);
        migrationBuilder.DropIndex(
            name: "IX_creation_receipts_actor_id_purpose_sequence",
            table: "creation_receipts");

        migrationBuilder.DropIndex(
            name: "IX_creation_receipts_sequence",
            table: "creation_receipts");

        migrationBuilder.DropIndex(
            name: "IX_creation_receipts_unacknowledged",
            table: "creation_receipts");

        migrationBuilder.DropCheckConstraint(
            name: "CK_creation_receipts_purpose",
            table: "creation_receipts");

        migrationBuilder.DropColumn(
            name: "acknowledged",
            table: "creation_receipts");

        migrationBuilder.DropColumn(
            name: "purpose",
            table: "creation_receipts");

        migrationBuilder.DropColumn(
            name: "sequence",
            table: "creation_receipts");

        migrationBuilder.DropColumn(
            name: "source_project_id",
            table: "creation_receipts");
    }
}
