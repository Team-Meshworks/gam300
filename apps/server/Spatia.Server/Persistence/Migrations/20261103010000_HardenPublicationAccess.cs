using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

// Retain edition identity and permanent deletion independently of ordinary runtime table grants
[DbContext(typeof(ApplicationDbContext))]
[Migration("20261103010000_HardenPublicationAccess")]
public sealed class HardenPublicationAccess : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Runtime DELETE must not allow another insert to replace an immutable edition under the same URL
        // Privileged retention changes require a separate reviewed migration rather than a runtime escape hatch
        migrationBuilder.Sql("""
            CREATE TRIGGER "TR_publications_no_delete"
                BEFORE DELETE ON publications
                FOR EACH ROW EXECUTE FUNCTION reject_publication_update();

            CREATE FUNCTION retain_publication_access_deletion() RETURNS trigger
            LANGUAGE plpgsql AS $permanent$
            BEGIN
                IF TG_OP = 'DELETE' OR (OLD."Deleted" AND NOT NEW."Deleted") THEN
                    RAISE EXCEPTION USING ERRCODE = '23514',
                        CONSTRAINT = 'CK_publication_access_permanent',
                        MESSAGE = 'Publication deletion cannot be reversed or replaced.';
                END IF;
                RETURN NEW;
            END;
            $permanent$;

            CREATE TRIGGER "TR_publication_access_permanent"
                BEFORE UPDATE OR DELETE ON publication_access
                FOR EACH ROW EXECUTE FUNCTION retain_publication_access_deletion();
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // A controlled schema rollback removes only these guards and leaves edition and policy rows intact
        migrationBuilder.Sql("""
            DROP TRIGGER "TR_publication_access_permanent" ON publication_access;
            DROP FUNCTION retain_publication_access_deletion();
            DROP TRIGGER "TR_publications_no_delete" ON publications;
            """);
    }
}
