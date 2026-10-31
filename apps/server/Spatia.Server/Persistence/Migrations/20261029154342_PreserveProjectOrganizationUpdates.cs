using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class PreserveProjectOrganizationUpdates : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropForeignKey(
            name: "FK_class_assignment_students_projects_project_id_organization_~",
            table: "class_assignment_students");

        migrationBuilder.DropForeignKey(
            name: "FK_class_assignments_projects_source_project_id_organization_id",
            table: "class_assignments");

        migrationBuilder.DropForeignKey(
            name: "FK_project_provenance_projects_project_id_organization_id",
            table: "project_provenance");

        migrationBuilder.DropUniqueConstraint(
            name: "AK_projects_id_organization_id",
            table: "projects");

        migrationBuilder.DropIndex(
            name: "IX_project_provenance_project_id_organization_id",
            table: "project_provenance");

        migrationBuilder.DropIndex(
            name: "IX_class_assignments_source_project_id_organization_id",
            table: "class_assignments");

        migrationBuilder.DropIndex(
            name: "IX_class_assignment_students_project_id_organization_id",
            table: "class_assignment_students");

        migrationBuilder.CreateIndex(
            name: "IX_projects_id_organization_id",
            table: "projects",
            columns: new[] { "id", "organization_id" },
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_class_assignments_source_project_id",
            table: "class_assignments",
            column: "source_project_id");

        migrationBuilder.AddForeignKey(
            name: "FK_class_assignment_students_projects_project_id",
            table: "class_assignment_students",
            column: "project_id",
            principalTable: "projects",
            principalColumn: "id",
            onDelete: ReferentialAction.Restrict);

        migrationBuilder.AddForeignKey(
            name: "FK_class_assignments_projects_source_project_id",
            table: "class_assignments",
            column: "source_project_id",
            principalTable: "projects",
            principalColumn: "id",
            onDelete: ReferentialAction.Restrict);

        migrationBuilder.AddForeignKey(
            name: "FK_project_provenance_projects_project_id",
            table: "project_provenance",
            column: "project_id",
            principalTable: "projects",
            principalColumn: "id",
            onDelete: ReferentialAction.Restrict);

        // These composite constraints protect organization boundaries without an EF alternate key.
        migrationBuilder.AddForeignKey(
            name: "FK_class_assignment_students_projects_project_id_organization_~",
            table: "class_assignment_students",
            columns: new[] { "project_id", "organization_id" },
            principalTable: "projects",
            principalColumns: new[] { "id", "organization_id" },
            onDelete: ReferentialAction.Restrict);

        migrationBuilder.AddForeignKey(
            name: "FK_class_assignments_projects_source_project_id_organization_id",
            table: "class_assignments",
            columns: new[] { "source_project_id", "organization_id" },
            principalTable: "projects",
            principalColumns: new[] { "id", "organization_id" },
            onDelete: ReferentialAction.Restrict);

        migrationBuilder.AddForeignKey(
            name: "FK_project_provenance_projects_project_id_organization_id",
            table: "project_provenance",
            columns: new[] { "project_id", "organization_id" },
            principalTable: "projects",
            principalColumns: new[] { "id", "organization_id" },
            onDelete: ReferentialAction.Restrict);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropForeignKey(
            name: "FK_class_assignment_students_projects_project_id_organization_~",
            table: "class_assignment_students");

        migrationBuilder.DropForeignKey(
            name: "FK_class_assignments_projects_source_project_id_organization_id",
            table: "class_assignments");

        migrationBuilder.DropForeignKey(
            name: "FK_project_provenance_projects_project_id_organization_id",
            table: "project_provenance");

        migrationBuilder.DropForeignKey(
            name: "FK_class_assignment_students_projects_project_id",
            table: "class_assignment_students");

        migrationBuilder.DropForeignKey(
            name: "FK_class_assignments_projects_source_project_id",
            table: "class_assignments");

        migrationBuilder.DropForeignKey(
            name: "FK_project_provenance_projects_project_id",
            table: "project_provenance");

        migrationBuilder.DropIndex(
            name: "IX_projects_id_organization_id",
            table: "projects");

        migrationBuilder.DropIndex(
            name: "IX_class_assignments_source_project_id",
            table: "class_assignments");

        migrationBuilder.AddUniqueConstraint(
            name: "AK_projects_id_organization_id",
            table: "projects",
            columns: new[] { "id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_project_provenance_project_id_organization_id",
            table: "project_provenance",
            columns: new[] { "project_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignments_source_project_id_organization_id",
            table: "class_assignments",
            columns: new[] { "source_project_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_project_id_organization_id",
            table: "class_assignment_students",
            columns: new[] { "project_id", "organization_id" });

        migrationBuilder.AddForeignKey(
            name: "FK_class_assignment_students_projects_project_id_organization_~",
            table: "class_assignment_students",
            columns: new[] { "project_id", "organization_id" },
            principalTable: "projects",
            principalColumns: new[] { "id", "organization_id" },
            onDelete: ReferentialAction.Restrict);

        migrationBuilder.AddForeignKey(
            name: "FK_class_assignments_projects_source_project_id_organization_id",
            table: "class_assignments",
            columns: new[] { "source_project_id", "organization_id" },
            principalTable: "projects",
            principalColumns: new[] { "id", "organization_id" },
            onDelete: ReferentialAction.Restrict);

        migrationBuilder.AddForeignKey(
            name: "FK_project_provenance_projects_project_id_organization_id",
            table: "project_provenance",
            columns: new[] { "project_id", "organization_id" },
            principalTable: "projects",
            principalColumns: new[] { "id", "organization_id" },
            onDelete: ReferentialAction.Restrict);
    }
}
