using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddProgressReviews : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "progress_reviews",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                project_id = table.Column<Guid>(type: "uuid", nullable: false),
                educator_id = table.Column<Guid>(type: "uuid", nullable: false),
                revision = table.Column<long>(type: "bigint", nullable: false),
                feedback = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "statement_timestamp()")
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_progress_reviews", x => x.id);
                table.CheckConstraint("CK_progress_reviews_feedback", "length(feedback) BETWEEN 1 AND 4000");
                table.CheckConstraint("CK_progress_reviews_revision", "revision BETWEEN 0 AND 9007199254740991");
                table.ForeignKey(
                    name: "FK_progress_reviews_AspNetUsers_educator_id",
                    column: x => x.educator_id,
                    principalTable: "AspNetUsers",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_progress_reviews_projects_project_id",
                    column: x => x.project_id,
                    principalTable: "projects",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_progress_reviews_educator_id",
            table: "progress_reviews",
            column: "educator_id");

        migrationBuilder.CreateIndex(
            name: "IX_progress_reviews_project_id_id",
            table: "progress_reviews",
            columns: new[] { "project_id", "id" });
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "progress_reviews");
    }
}
