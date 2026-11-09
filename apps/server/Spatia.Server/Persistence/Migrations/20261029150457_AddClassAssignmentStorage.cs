using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddClassAssignmentStorage : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddUniqueConstraint(
            name: "AK_projects_id_organization_id",
            table: "projects",
            columns: new[] { "id", "organization_id" });

        migrationBuilder.CreateTable(
            name: "class_assignments",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                classroom_id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                created_by_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                source_project_id = table.Column<Guid>(type: "uuid", nullable: false),
                source_revision = table.Column<long>(type: "bigint", nullable: false),
                due_at_unix_seconds = table.Column<long>(type: "bigint", nullable: false),
                title = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                description = table.Column<string>(type: "text", nullable: false),
                instructions = table.Column<string>(type: "text", nullable: false),
                request_digest = table.Column<byte[]>(type: "bytea", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_class_assignments", x => x.id);
                table.UniqueConstraint("AK_class_assignments_id_classroom_id_organization_id", x => new { x.id, x.classroom_id, x.organization_id });
                table.CheckConstraint("CK_class_assignments_description", "length(btrim(description)) > 0");
                table.CheckConstraint("CK_class_assignments_due", "due_at_unix_seconds BETWEEN -62135596800 AND 253402300799");
                table.CheckConstraint("CK_class_assignments_instructions", "length(btrim(instructions)) > 0");
                table.CheckConstraint("CK_class_assignments_request_digest", "octet_length(request_digest) = 32");
                table.CheckConstraint("CK_class_assignments_source_revision", "source_revision BETWEEN 0 AND 9007199254740991");
                table.CheckConstraint("CK_class_assignments_title", "length(btrim(title)) BETWEEN 1 AND 256");
                table.ForeignKey(
                    name: "FK_class_assignments_AspNetUsers_created_by_user_id",
                    column: x => x.created_by_user_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_class_assignments_classrooms_classroom_id_organization_id",
                    columns: x => new { x.classroom_id, x.organization_id },
                    principalTable: "classrooms",
                    principalColumns: new[] { "id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_class_assignments_projects_source_project_id_organization_id",
                    columns: x => new { x.source_project_id, x.organization_id },
                    principalTable: "projects",
                    principalColumns: new[] { "id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateTable(
            name: "class_assignment_students",
            columns: table => new
            {
                assignment_id = table.Column<Guid>(type: "uuid", nullable: false),
                student_id = table.Column<Guid>(type: "uuid", nullable: false),
                classroom_id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                role_id = table.Column<Guid>(type: "uuid", nullable: false),
                project_id = table.Column<Guid>(type: "uuid", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_class_assignment_students", x => new { x.assignment_id, x.student_id });
                table.UniqueConstraint("AK_class_assignment_students_assignment_id_student_id_organiza~", x => new { x.assignment_id, x.student_id, x.organization_id });
                table.CheckConstraint("CK_class_assignment_students_role_id", "role_id = '862d776c-4d56-4dd8-919d-26044b6d8a44'::uuid");
                table.ForeignKey(
                    name: "FK_class_assignment_students_class_assignments_assignment_id_c~",
                    columns: x => new { x.assignment_id, x.classroom_id, x.organization_id },
                    principalTable: "class_assignments",
                    principalColumns: new[] { "id", "classroom_id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_class_assignment_students_classroom_members_classroom_id_st~",
                    columns: x => new { x.classroom_id, x.student_id },
                    principalTable: "classroom_members",
                    principalColumns: new[] { "classroom_id", "user_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_class_assignment_students_organization_memberships_organiza~",
                    columns: x => new { x.organization_id, x.student_id, x.role_id },
                    principalTable: "organization_memberships",
                    principalColumns: new[] { "organization_id", "user_id", "role_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_class_assignment_students_projects_project_id_organization_~",
                    columns: x => new { x.project_id, x.organization_id },
                    principalTable: "projects",
                    principalColumns: new[] { "id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateTable(
            name: "project_provenance",
            columns: table => new
            {
                project_id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                class_assignment_id = table.Column<Guid>(type: "uuid", nullable: true),
                student_id = table.Column<Guid>(type: "uuid", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_project_provenance", x => x.project_id);
                table.CheckConstraint("CK_project_provenance_kind", "(kind = 'ordinary' AND class_assignment_id IS NULL AND student_id IS NULL)\nOR (kind = 'class' AND class_assignment_id IS NOT NULL AND student_id IS NOT NULL)");
                table.ForeignKey(
                    name: "FK_project_provenance_class_assignment_students_class_assignme~",
                    columns: x => new { x.class_assignment_id, x.student_id, x.organization_id },
                    principalTable: "class_assignment_students",
                    principalColumns: new[] { "assignment_id", "student_id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_project_provenance_projects_project_id_organization_id",
                    columns: x => new { x.project_id, x.organization_id },
                    principalTable: "projects",
                    principalColumns: new[] { "id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_assignment_id_classroom_id_organi~",
            table: "class_assignment_students",
            columns: new[] { "assignment_id", "classroom_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_classroom_id_student_id",
            table: "class_assignment_students",
            columns: new[] { "classroom_id", "student_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_organization_id_student_id_role_id",
            table: "class_assignment_students",
            columns: new[] { "organization_id", "student_id", "role_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_project_id",
            table: "class_assignment_students",
            column: "project_id",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_project_id_organization_id",
            table: "class_assignment_students",
            columns: new[] { "project_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignment_students_student_id_assignment_id",
            table: "class_assignment_students",
            columns: new[] { "student_id", "assignment_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignments_classroom_id_id",
            table: "class_assignments",
            columns: new[] { "classroom_id", "id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignments_classroom_id_organization_id",
            table: "class_assignments",
            columns: new[] { "classroom_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_class_assignments_created_by_user_id",
            table: "class_assignments",
            column: "created_by_user_id");

        migrationBuilder.CreateIndex(
            name: "IX_class_assignments_source_project_id_organization_id",
            table: "class_assignments",
            columns: new[] { "source_project_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_project_provenance_class_assignment_id_student_id_organizat~",
            table: "project_provenance",
            columns: new[] { "class_assignment_id", "student_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_project_provenance_project_id_organization_id",
            table: "project_provenance",
            columns: new[] { "project_id", "organization_id" });
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "project_provenance");

        migrationBuilder.DropTable(
            name: "class_assignment_students");

        migrationBuilder.DropTable(
            name: "class_assignments");

        migrationBuilder.DropUniqueConstraint(
            name: "AK_projects_id_organization_id",
            table: "projects");
    }
}
