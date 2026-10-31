using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddClassrooms : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddUniqueConstraint(
            name: "AK_organization_memberships_organization_id_user_id_role_id",
            table: "organization_memberships",
            columns: new[] { "organization_id", "user_id", "role_id" });

        migrationBuilder.CreateTable(
            name: "classrooms",
            columns: table => new
            {
                id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                name = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_classrooms", x => x.id);
                table.UniqueConstraint("AK_classrooms_id_organization_id", x => new { x.id, x.organization_id });
                table.CheckConstraint("CK_classrooms_name", "length(btrim(name)) BETWEEN 1 AND 256");
                table.ForeignKey(
                    name: "FK_classrooms_organizations_organization_id",
                    column: x => x.organization_id,
                    principalTable: "organizations",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateTable(
            name: "classroom_members",
            columns: table => new
            {
                classroom_id = table.Column<Guid>(type: "uuid", nullable: false),
                user_id = table.Column<Guid>(type: "uuid", nullable: false),
                organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                role_id = table.Column<Guid>(type: "uuid", nullable: false),
                active = table.Column<bool>(type: "boolean", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_classroom_members", x => new { x.classroom_id, x.user_id });
                table.CheckConstraint("CK_classroom_members_role_id", "role_id IN ('d14c51b6-510a-4430-a27c-bfdc6e9d801b'::uuid, '862d776c-4d56-4dd8-919d-26044b6d8a44'::uuid)");
                table.ForeignKey(
                    name: "FK_classroom_members_classrooms_classroom_id_organization_id",
                    columns: x => new { x.classroom_id, x.organization_id },
                    principalTable: "classrooms",
                    principalColumns: new[] { "id", "organization_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_classroom_members_organization_memberships_organization_id_~",
                    columns: x => new { x.organization_id, x.user_id, x.role_id },
                    principalTable: "organization_memberships",
                    principalColumns: new[] { "organization_id", "user_id", "role_id" },
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateIndex(
            name: "IX_classroom_members_classroom_id_organization_id",
            table: "classroom_members",
            columns: new[] { "classroom_id", "organization_id" });

        migrationBuilder.CreateIndex(
            name: "IX_classroom_members_organization_id_user_id_role_id",
            table: "classroom_members",
            columns: new[] { "organization_id", "user_id", "role_id" });

        migrationBuilder.CreateIndex(
            name: "IX_classroom_members_user_id_active_classroom_id",
            table: "classroom_members",
            columns: new[] { "user_id", "active", "classroom_id" });

        migrationBuilder.CreateIndex(
            name: "IX_classrooms_organization_id",
            table: "classrooms",
            column: "organization_id");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "classroom_members");

        migrationBuilder.DropTable(
            name: "classrooms");

        migrationBuilder.DropUniqueConstraint(
            name: "AK_organization_memberships_organization_id_user_id_role_id",
            table: "organization_memberships");
    }
}
