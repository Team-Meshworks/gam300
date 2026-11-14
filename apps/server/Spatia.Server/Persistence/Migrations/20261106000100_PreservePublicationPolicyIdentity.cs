using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261106000100_PreservePublicationPolicyIdentity")]
public sealed class PreservePublicationPolicyIdentity : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Policy restrictions must remain bound to the edition that received them
        migrationBuilder.Sql("""
            CREATE OR REPLACE FUNCTION retain_publication_access_deletion() RETURNS trigger
            LANGUAGE plpgsql AS $permanent$
            BEGIN
                IF TG_OP = 'DELETE' OR OLD."PublicationId" IS DISTINCT FROM NEW."PublicationId"
                    OR (OLD."Deleted" AND NOT NEW."Deleted") THEN
                    RAISE EXCEPTION USING ERRCODE = '23514',
                        CONSTRAINT = 'CK_publication_access_permanent',
                        MESSAGE = 'Publication policy identity and permanent deletion cannot be changed.';
                END IF;
                RETURN NEW;
            END;
            $permanent$;
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            CREATE OR REPLACE FUNCTION retain_publication_access_deletion() RETURNS trigger
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
            """);
    }
}
