using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddProjectImages : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<Guid>(
            name: "image_id",
            table: "projects",
            type: "uuid",
            nullable: true);

        migrationBuilder.CreateTable(
            name: "project_images",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                type = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                content_type = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                data = table.Column<byte[]>(type: "bytea", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_project_images", x => x.id);
                table.CheckConstraint("CK_project_images_content_type", "content_type IN ('image/png', 'image/jpeg', 'image/webp')");
                table.CheckConstraint("CK_project_images_data", "octet_length(data) BETWEEN 1 AND 2097152");
                table.CheckConstraint("CK_project_images_type", "type IN ('cover', 'panorama')");
            });

        migrationBuilder.CreateIndex(
            name: "IX_projects_image_id",
            table: "projects",
            column: "image_id");

        migrationBuilder.AddForeignKey(
            name: "FK_projects_project_images_image_id",
            table: "projects",
            column: "image_id",
            principalTable: "project_images",
            principalColumn: "id",
            onDelete: ReferentialAction.Restrict);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Refuse destructive rollback once real project imagery exists
        migrationBuilder.Sql("""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM project_images) THEN
                    RAISE EXCEPTION 'Project images must be retained before downgrading';
                END IF;
            END $$;
            """);
        migrationBuilder.DropForeignKey(
            name: "FK_projects_project_images_image_id",
            table: "projects");

        migrationBuilder.DropTable(
            name: "project_images");

        migrationBuilder.DropIndex(
            name: "IX_projects_image_id",
            table: "projects");

        migrationBuilder.DropColumn(
            name: "image_id",
            table: "projects");
    }
}
