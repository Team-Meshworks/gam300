using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddPublicationSnapshots : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Keep references inside the immutable snapshot row: no separate, later asset inserts.
        // This checks storage shape only; approval, completeness and bytes belong to the resolver/coordinator.
        migrationBuilder.Sql("""
            CREATE FUNCTION publication_asset_references_valid(refs jsonb) RETURNS boolean
            LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $manifest$
            DECLARE
                reference jsonb;
            BEGIN
                IF jsonb_typeof(refs) <> 'array' THEN
                    RETURN FALSE;
                END IF;
                FOR reference IN SELECT jsonb_array_elements(refs) LOOP
                    IF jsonb_typeof(reference) <> 'object' THEN
                        RETURN FALSE;
                    END IF;
                    IF (
                        jsonb_typeof(reference -> 'assetId') = 'string'
                        AND (reference ->> 'assetId') ~ '[^[:space:]]'
                        AND jsonb_typeof(reference -> 'sha256') = 'string'
                        AND (reference ->> 'sha256') COLLATE "C" ~ '^[0-9a-f]{64}$'
                        AND (reference - 'assetId' - 'sha256') = '{}'::jsonb
                    ) IS NOT TRUE THEN
                        RETURN FALSE;
                    END IF;
                END LOOP;
                RETURN NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements(refs) AS entries(entry)
                    GROUP BY (entry ->> 'assetId') COLLATE "C" HAVING count(*) > 1
                );
            END;
            $manifest$;
            """);

        migrationBuilder.CreateTable(
            name: "publications",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                project_id = table.Column<Guid>(type: "uuid", nullable: false),
                published_by_id = table.Column<Guid>(type: "uuid", nullable: false),
                source_revision = table.Column<long>(type: "bigint", nullable: false),
                schema_version = table.Column<int>(type: "integer", nullable: false),
                document = table.Column<string>(type: "jsonb", nullable: false),
                asset_references = table.Column<string>(type: "jsonb", nullable: false),
                request_digest = table.Column<byte[]>(type: "bytea", nullable: false),
                created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "statement_timestamp()")
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_publications", x => x.id);
                table.CheckConstraint("CK_publications_asset_references", "publication_asset_references_valid(asset_references) IS TRUE");
                table.CheckConstraint("CK_publications_created_at", "isfinite(created_at)");
                table.CheckConstraint("CK_publications_document", "(\n    jsonb_typeof(document) = 'object'\n    AND jsonb_typeof(document -> 'projectId') = 'string'\n    AND lower(document ->> 'projectId') = project_id::text\n    AND jsonb_typeof(document -> 'schemaVersion') = 'number'\n    AND document -> 'schemaVersion' = to_jsonb(schema_version)\n) IS TRUE");
                table.CheckConstraint("CK_publications_id", "id <> '00000000-0000-0000-0000-000000000000'::uuid");
                table.CheckConstraint("CK_publications_request_digest", "octet_length(request_digest) = 32");
                table.CheckConstraint("CK_publications_schema_version", "schema_version > 0");
                table.CheckConstraint("CK_publications_source_revision", "source_revision BETWEEN 0 AND 9007199254740991");
                table.ForeignKey(
                    name: "FK_publications_AspNetUsers_published_by_id",
                    column: x => x.published_by_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_publications_projects_project_id",
                    column: x => x.project_id,
                    principalTable: "projects",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_publications_project_id_source_revision",
            table: "publications",
            columns: new[] { "project_id", "source_revision" });

        migrationBuilder.CreateIndex(
            name: "IX_publications_published_by_id",
            table: "publications",
            column: "published_by_id");

        migrationBuilder.Sql("""
            CREATE FUNCTION reject_publication_update() RETURNS trigger
            LANGUAGE plpgsql AS $immutable$
            BEGIN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    CONSTRAINT = 'CK_publications_immutable',
                    MESSAGE = 'Publication snapshots cannot be updated.';
            END;
            $immutable$;

            CREATE TRIGGER "TR_publications_immutable"
                BEFORE UPDATE ON publications
                FOR EACH ROW EXECUTE FUNCTION reject_publication_update();
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "publications");
        migrationBuilder.Sql("DROP FUNCTION reject_publication_update();");
        migrationBuilder.Sql("DROP FUNCTION publication_asset_references_valid(jsonb);");
    }
}
