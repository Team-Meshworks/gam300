using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261127000000_PreserveDevelopmentAssetNonBlocking")]
public sealed class PreserveDevelopmentAssetNonBlocking : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("ALTER TABLE development_publication_assets ADD COLUMN non_blocking boolean NOT NULL DEFAULT false;");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("ALTER TABLE development_publication_assets DROP COLUMN non_blocking;");
    }
}
