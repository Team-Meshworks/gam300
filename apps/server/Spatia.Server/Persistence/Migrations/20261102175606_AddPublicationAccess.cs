using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class AddPublicationAccess : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "publication_access",
            columns: table => new
            {
                PublicationId = table.Column<Guid>(type: "uuid", nullable: false),
                Audience = table.Column<int>(type: "integer", nullable: false),
                Hidden = table.Column<bool>(type: "boolean", nullable: false),
                Revoked = table.Column<bool>(type: "boolean", nullable: false),
                Deleted = table.Column<bool>(type: "boolean", nullable: false),
                ViewerIds = table.Column<Guid[]>(type: "uuid[]", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_publication_access", x => x.PublicationId);
                table.ForeignKey(
                    name: "FK_publication_access_publications_PublicationId",
                    column: x => x.PublicationId,
                    principalTable: "publications",
                    principalColumn: "id",
                    onDelete: ReferentialAction.Restrict);
            });
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "publication_access");
    }
}
