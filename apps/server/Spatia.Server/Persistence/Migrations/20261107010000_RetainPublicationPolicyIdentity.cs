using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261107010000_RetainPublicationPolicyIdentity")]
public sealed class RetainPublicationPolicyIdentity : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) => ReplaceFunction(migrationBuilder, true);

    // The preceding migrations also protect identity, including after downgrade
    protected override void Down(MigrationBuilder migrationBuilder) => ReplaceFunction(migrationBuilder, true);

    private static void ReplaceFunction(MigrationBuilder migrationBuilder, bool protectIdentity)
    {
        var identityCheck = protectIdentity ? " OR OLD.\"PublicationId\" IS DISTINCT FROM NEW.\"PublicationId\"" : "";
        migrationBuilder.Sql($"""
            CREATE OR REPLACE FUNCTION retain_publication_access_deletion() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM publications
                    WHERE id = OLD."PublicationId" AND organization_purge_matches(project_id)) THEN
                    RETURN OLD;
                END IF;
                IF TG_OP = 'DELETE'{identityCheck} OR (OLD."Deleted" AND NOT NEW."Deleted") THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_publication_access_permanent',
                        MESSAGE = 'Publication policy identity and permanent deletion cannot be changed.';
                END IF;
                RETURN NEW;
            END;
            $$;
            """);
    }
}
