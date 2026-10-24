using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddProjectDraftStorage : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "projects",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                archived = table.Column<bool>(type: "boolean", nullable: false),
                revision = table.Column<long>(type: "bigint", nullable: false),
                schema_version = table.Column<int>(type: "integer", nullable: false),
                document = table.Column<string>(type: "jsonb", nullable: false),
                updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                last_mutation_actor_id = table.Column<Guid>(type: "uuid", nullable: true),
                last_mutation_id = table.Column<Guid>(type: "uuid", nullable: true),
                last_mutation_digest = table.Column<byte[]>(type: "bytea", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_projects", x => x.id);
                table.CheckConstraint("CK_projects_document", "(\n    jsonb_typeof(document) = 'object'\n    AND jsonb_typeof(document -> 'projectId') = 'string'\n    AND lower(document ->> 'projectId') = id::text\n    AND jsonb_typeof(document -> 'schemaVersion') = 'number'\n    AND document -> 'schemaVersion' = to_jsonb(schema_version)\n) IS TRUE");
                table.CheckConstraint("CK_projects_last_mutation", "(last_mutation_actor_id IS NULL AND last_mutation_id IS NULL AND last_mutation_digest IS NULL)\nOR (last_mutation_actor_id IS NOT NULL AND last_mutation_id IS NOT NULL\n    AND last_mutation_digest IS NOT NULL AND octet_length(last_mutation_digest) = 32)");
                table.CheckConstraint("CK_projects_revision", "revision BETWEEN 0 AND 9007199254740991");
                table.CheckConstraint("CK_projects_schema_version", "schema_version > 0");
                table.CheckConstraint("CK_projects_updated_at", "isfinite(updated_at)");
                table.ForeignKey(
                    name: "FK_projects_AspNetUsers_last_mutation_actor_id",
                    column: x => x.last_mutation_actor_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_projects_organizations_organization_id",
                    column: x => x.organization_id,
                    principalTable: "organizations",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateTable(
            name: "project_assignments",
            columns: table => new
            {
                project_id = table.Column<Guid>(type: "uuid", nullable: false),
                user_id = table.Column<Guid>(type: "uuid", nullable: false),
                can_edit = table.Column<bool>(type: "boolean", nullable: false),
                can_manage = table.Column<bool>(type: "boolean", nullable: false),
                can_publish = table.Column<bool>(type: "boolean", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_project_assignments", x => new { x.project_id, x.user_id });
                table.ForeignKey(
                    name: "FK_project_assignments_AspNetUsers_user_id",
                    column: x => x.user_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_project_assignments_projects_project_id",
                    column: x => x.project_id,
                    principalTable: "projects",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_project_assignments_user_id_project_id",
            table: "project_assignments",
            columns: new[] { "user_id", "project_id" });

        migrationBuilder.CreateIndex(
            name: "IX_projects_last_mutation_actor_id",
            table: "projects",
            column: "last_mutation_actor_id");

        migrationBuilder.CreateIndex(
            name: "IX_projects_organization_id_archived",
            table: "projects",
            columns: new[] { "organization_id", "archived" });
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "project_assignments");

        migrationBuilder.DropTable(
            name: "projects");
    }
}
