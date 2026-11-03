using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddReviewEvidence : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            CREATE FUNCTION review_asset_references_valid(refs jsonb) RETURNS boolean
            LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $manifest$
            DECLARE reference jsonb;
            BEGIN
                IF jsonb_typeof(refs) <> 'array' THEN RETURN FALSE; END IF;
                FOR reference IN SELECT jsonb_array_elements(refs) LOOP
                    IF (jsonb_typeof(reference) = 'object'
                        AND jsonb_typeof(reference -> 'assetId') = 'string'
                        AND (reference ->> 'assetId') ~ '[^[:space:]]'
                        AND jsonb_typeof(reference -> 'sha256') = 'string'
                        AND (reference ->> 'sha256') COLLATE "C" ~ '^[0-9a-f]{64}$'
                        AND (reference - 'assetId' - 'sha256') = '{}'::jsonb) IS NOT TRUE
                    THEN RETURN FALSE; END IF;
                END LOOP;
                RETURN NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements(refs) AS entries(entry)
                    GROUP BY (entry ->> 'assetId') COLLATE "C" HAVING count(*) > 1
                );
            END;
            $manifest$;
            """);
        migrationBuilder.AddUniqueConstraint(
            name: "AK_class_assignment_students_project_id_student_id",
            table: "class_assignment_students",
            columns: new[] { "project_id", "student_id" });

        migrationBuilder.CreateTable(
            name: "review_submissions",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                project_id = table.Column<Guid>(type: "uuid", nullable: false),
                student_id = table.Column<Guid>(type: "uuid", nullable: false),
                sequence = table.Column<long>(type: "bigint", nullable: false),
                source_revision = table.Column<long>(type: "bigint", nullable: false),
                due_at_unix_seconds = table.Column<long>(type: "bigint", nullable: false),
                schema_version = table.Column<int>(type: "integer", nullable: false),
                completion_confirmed = table.Column<bool>(type: "boolean", nullable: false),
                document = table.Column<string>(type: "jsonb", nullable: false),
                asset_references = table.Column<string>(type: "jsonb", nullable: false),
                request_digest = table.Column<byte[]>(type: "bytea", nullable: false),
                submitted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "statement_timestamp()")
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_review_submissions", x => x.id);
                table.CheckConstraint("CK_review_submissions_assets", "review_asset_references_valid(asset_references) IS TRUE");
                table.CheckConstraint("CK_review_submissions_completion", "completion_confirmed IS TRUE");
                table.CheckConstraint("CK_review_submissions_digest", "octet_length(request_digest) = 32");
                table.CheckConstraint("CK_review_submissions_due", "due_at_unix_seconds BETWEEN -62135596800 AND 253402300799");
                table.CheckConstraint("CK_review_submissions_document", "(jsonb_typeof(document) = 'object' AND jsonb_typeof(document -> 'projectId') = 'string'\nAND lower(document ->> 'projectId') = project_id::text\nAND jsonb_typeof(document -> 'schemaVersion') = 'number'\nAND document -> 'schemaVersion' = to_jsonb(schema_version)) IS TRUE");
                table.CheckConstraint("CK_review_submissions_id", "id <> '00000000-0000-0000-0000-000000000000'::uuid");
                table.CheckConstraint("CK_review_submissions_revision", "source_revision BETWEEN 0 AND 9007199254740991");
                table.CheckConstraint("CK_review_submissions_schema", "schema_version > 0");
                table.CheckConstraint("CK_review_submissions_sequence", "sequence > 0");
                table.CheckConstraint("CK_review_submissions_timestamp", "isfinite(submitted_at)");
                table.ForeignKey(
                    name: "FK_review_submissions_class_assignment_students_project_id_stu~",
                    columns: x => new { x.project_id, x.student_id },
                    principalTable: "class_assignment_students",
                    principalColumns: new[] { "project_id", "student_id" },
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateTable(
            name: "review_decisions",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                submission_id = table.Column<Guid>(type: "uuid", nullable: false),
                educator_id = table.Column<Guid>(type: "uuid", nullable: false),
                sequence = table.Column<long>(type: "bigint", nullable: false),
                outcome = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                feedback = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                request_digest = table.Column<byte[]>(type: "bytea", nullable: false),
                decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "statement_timestamp()")
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_review_decisions", x => x.id);
                table.CheckConstraint("CK_review_decisions_digest", "octet_length(request_digest) = 32");
                table.CheckConstraint("CK_review_decisions_feedback", "length(feedback) <= 4000");
                table.CheckConstraint("CK_review_decisions_id", "id <> '00000000-0000-0000-0000-000000000000'::uuid");
                table.CheckConstraint("CK_review_decisions_outcome", "outcome IN ('approved', 'returned', 'revoked')");
                table.CheckConstraint("CK_review_decisions_sequence", "sequence > 0");
                table.CheckConstraint("CK_review_decisions_timestamp", "isfinite(decided_at)");
                table.ForeignKey(
                    name: "FK_review_decisions_AspNetUsers_educator_id",
                    column: x => x.educator_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_review_decisions_review_submissions_submission_id",
                    column: x => x.submission_id,
                    principalTable: "review_submissions",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_review_decisions_educator_id",
            table: "review_decisions",
            column: "educator_id");

        migrationBuilder.CreateIndex(
            name: "IX_review_decisions_submission_id_sequence",
            table: "review_decisions",
            columns: new[] { "submission_id", "sequence" },
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_review_submissions_project_id_sequence",
            table: "review_submissions",
            columns: new[] { "project_id", "sequence" },
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_review_submissions_project_id_student_id",
            table: "review_submissions",
            columns: new[] { "project_id", "student_id" });

        migrationBuilder.Sql("""
            CREATE FUNCTION reject_review_evidence_change() RETURNS trigger
            LANGUAGE plpgsql AS $immutable$
            BEGIN
                RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_review_evidence_immutable',
                    MESSAGE = 'Review evidence cannot be changed.';
            END;
            $immutable$;
            CREATE TRIGGER "TR_review_submissions_immutable" BEFORE UPDATE OR DELETE ON review_submissions
                FOR EACH ROW EXECUTE FUNCTION reject_review_evidence_change();
            CREATE TRIGGER "TR_review_decisions_immutable" BEFORE UPDATE OR DELETE ON review_decisions
                FOR EACH ROW EXECUTE FUNCTION reject_review_evidence_change();
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DO $guard$
            BEGIN
                IF EXISTS (SELECT 1 FROM review_submissions) OR EXISTS (SELECT 1 FROM review_decisions) THEN
                    RAISE EXCEPTION 'Review evidence must be retained before rolling back this migration.';
                END IF;
            END;
            $guard$;
            """);
        migrationBuilder.DropTable(
            name: "review_decisions");

        migrationBuilder.DropTable(
            name: "review_submissions");

        migrationBuilder.DropUniqueConstraint(
            name: "AK_class_assignment_students_project_id_student_id",
            table: "class_assignment_students");

        migrationBuilder.Sql("DROP FUNCTION reject_review_evidence_change();");
        migrationBuilder.Sql("DROP FUNCTION review_asset_references_valid(jsonb);");
    }
}
