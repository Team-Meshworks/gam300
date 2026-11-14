using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261108160000_AddAccountDeletion")]
public sealed class AddAccountDeletion : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<bool>(name: "IsDeleted", table: "AspNetUsers", type: "boolean", nullable: false, defaultValue: false);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Keep deleted identities unavailable rather than silently restoring their management controls
        migrationBuilder.Sql("""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM "AspNetUsers" WHERE "IsDeleted") THEN
                    RAISE EXCEPTION 'Deleted account identities must be retained; review the downgrade first.';
                END IF;
            END $$;
            """);
        migrationBuilder.DropColumn(name: "IsDeleted", table: "AspNetUsers");
    }
}
