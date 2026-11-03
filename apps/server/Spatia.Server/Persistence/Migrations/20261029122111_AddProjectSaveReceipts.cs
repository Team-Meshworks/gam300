using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddProjectSaveReceipts : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "project_save_receipts",
            columns: table => new
            {
                project_id = table.Column<Guid>(type: "uuid", nullable: false),
                client_mutation_id = table.Column<Guid>(type: "uuid", nullable: false),
                actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                expected_revision = table.Column<long>(type: "bigint", nullable: false),
                revision = table.Column<long>(type: "bigint", nullable: false),
                request_digest = table.Column<byte[]>(type: "bytea", nullable: false),
                saved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_project_save_receipts", x => new { x.project_id, x.client_mutation_id });
                table.CheckConstraint("CK_project_save_receipts_digest", "octet_length(request_digest) = 32");
                table.CheckConstraint("CK_project_save_receipts_revision", "expected_revision BETWEEN 0 AND 9007199254740990 AND revision = expected_revision + 1");
                table.CheckConstraint("CK_project_save_receipts_saved_at", "isfinite(saved_at)");
                table.ForeignKey(
                    name: "FK_project_save_receipts_AspNetUsers_actor_id",
                    column: x => x.actor_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_project_save_receipts_projects_project_id",
                    column: x => x.project_id,
                    principalTable: "projects",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_project_save_receipts_actor_id",
            table: "project_save_receipts",
            column: "actor_id");

        migrationBuilder.CreateIndex(
            name: "IX_project_save_receipts_project_id_revision",
            table: "project_save_receipts",
            columns: new[] { "project_id", "revision" },
            unique: true);

        // Only the retained latest slot is recoverable; receipt constraints reject inconsistent legacy rows
        migrationBuilder.Sql("""
            INSERT INTO project_save_receipts
                (project_id, client_mutation_id, actor_id, expected_revision, revision, request_digest, saved_at)
            SELECT id, last_mutation_id, last_mutation_actor_id, revision - 1, revision, last_mutation_digest, updated_at
            FROM projects WHERE last_mutation_id IS NOT NULL;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "project_save_receipts");
    }
}
