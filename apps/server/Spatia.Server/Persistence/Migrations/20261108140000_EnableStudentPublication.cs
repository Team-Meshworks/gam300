using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261108140000_EnableStudentPublication")]
public sealed class EnableStudentPublication : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Upgrade untouched legacy drafts without overwriting later permission changes
        // Revised drafts need an explicit grant because their permission may have been revoked
        migrationBuilder.Sql("""
            UPDATE project_assignments AS assignment
            SET can_publish = TRUE
            FROM class_assignment_students AS student
            JOIN projects AS project ON project.id = student.project_id
            WHERE assignment.project_id = student.project_id
                AND assignment.user_id = student.student_id
                AND assignment.can_edit AND student.is_active
                AND project.revision = 0;
            """);
    }

    // Preserve current grants when rolling back; later permission decisions must not be overwritten
    protected override void Down(MigrationBuilder migrationBuilder) { }
}
