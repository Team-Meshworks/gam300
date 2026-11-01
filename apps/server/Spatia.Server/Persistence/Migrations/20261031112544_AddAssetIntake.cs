using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;
/// <inheritdoc />
public partial class AddAssetIntake : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "asset_candidates",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                category = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                validation = table.Column<string>(type: "jsonb", nullable: false),
                hidden = table.Column<bool>(type: "boolean", nullable: false),
                deleted = table.Column<bool>(type: "boolean", nullable: false),
                removed_from_projects = table.Column<bool>(type: "boolean", nullable: false),
                source = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                license = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                review_notes = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                submitted_by = table.Column<Guid>(type: "uuid", nullable: false),
                reviewed_by = table.Column<Guid>(type: "uuid", nullable: true),
                created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_asset_candidates", x => x.id);
                table.CheckConstraint("CK_asset_candidate_approval", "status <> 'approved' OR (reviewed_by IS NOT NULL AND source IS NOT NULL AND license IS NOT NULL AND review_notes IS NOT NULL)");
                table.CheckConstraint("CK_asset_candidate_kind", "kind IN ('model', 'environment')");
                table.CheckConstraint("CK_asset_candidate_retirement", "(NOT deleted OR hidden) AND (NOT removed_from_projects OR deleted)");
                table.CheckConstraint("CK_asset_candidate_size", "octet_length(bytes) BETWEEN 1 AND 20971520");
                table.CheckConstraint("CK_asset_candidate_status", "status IN ('pending', 'approved', 'invalid')");
                table.ForeignKey(
                    name: "FK_asset_candidates_AspNetUsers_reviewed_by",
                    column: x => x.reviewed_by,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_asset_candidates_AspNetUsers_submitted_by",
                    column: x => x.submitted_by,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_asset_candidates_kind_deleted_hidden",
            table: "asset_candidates",
            columns: new[] { "kind", "deleted", "hidden" });

        migrationBuilder.CreateIndex(
            name: "IX_asset_candidates_reviewed_by",
            table: "asset_candidates",
            column: "reviewed_by");

        migrationBuilder.CreateIndex(
            name: "IX_asset_candidates_submitted_by",
            table: "asset_candidates",
            column: "submitted_by");
        // Preserve immutable versions and tombstones even if a future writer bypasses this service
        migrationBuilder.Sql("""
            CREATE FUNCTION protect_asset_version() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'Retained asset versions cannot be deleted';
              END IF;
              IF ROW(NEW.id, NEW.name, NEW.kind, NEW.category, NEW.sha256, NEW.bytes, NEW.submitted_by, NEW.created_at, NEW.validation)
                 IS DISTINCT FROM ROW(OLD.id, OLD.name, OLD.kind, OLD.category, OLD.sha256, OLD.bytes, OLD.submitted_by, OLD.created_at, OLD.validation)
                 OR (OLD.status = 'approved' AND ROW(NEW.status, NEW.source, NEW.license, NEW.review_notes, NEW.reviewed_by)
                     IS DISTINCT FROM ROW(OLD.status, OLD.source, OLD.license, OLD.review_notes, OLD.reviewed_by))
                 OR (OLD.deleted AND NOT NEW.deleted)
                 OR (OLD.removed_from_projects AND NOT NEW.removed_from_projects) THEN
                RAISE EXCEPTION 'Immutable asset identity or retirement state cannot be changed';
              END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER protect_asset_version BEFORE UPDATE OR DELETE ON asset_candidates
            FOR EACH ROW EXECUTE FUNCTION protect_asset_version();
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "asset_candidates");
        migrationBuilder.Sql("DROP FUNCTION protect_asset_version()");
    }
}
