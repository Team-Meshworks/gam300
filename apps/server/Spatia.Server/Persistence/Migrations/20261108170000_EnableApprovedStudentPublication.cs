using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261108170000_EnableApprovedStudentPublication")]
public sealed class EnableApprovedStudentPublication : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Permission changes advance the revision, so only a still-current approval restores this grant
        migrationBuilder.Sql("""
            UPDATE project_assignments AS assignment
            SET can_publish = TRUE
            FROM class_assignment_students AS student
            JOIN projects AS project ON project.id = student.project_id
            JOIN LATERAL (
                SELECT id, source_revision FROM review_submissions
                WHERE project_id = project.id ORDER BY sequence DESC LIMIT 1
            ) AS submission ON submission.source_revision = project.revision
            JOIN LATERAL (
                SELECT outcome FROM review_decisions
                WHERE submission_id = submission.id ORDER BY sequence DESC LIMIT 1
            ) AS decision ON decision.outcome = 'approved'
            WHERE assignment.project_id = student.project_id
                AND assignment.user_id = student.student_id
                AND assignment.can_edit AND NOT assignment.can_publish
                AND student.is_active AND NOT project.archived;
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder) { }
}
