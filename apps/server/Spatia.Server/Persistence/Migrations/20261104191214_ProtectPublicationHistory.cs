using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

/// <inheritdoc />
public partial class ProtectPublicationHistory : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            CREATE OR REPLACE FUNCTION reject_publication_update() RETURNS trigger
            LANGUAGE plpgsql AS $immutable$
            BEGIN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    CONSTRAINT = 'CK_publications_immutable',
                    MESSAGE = 'Publication snapshots cannot be updated or deleted.';
            END;
            $immutable$;

            DROP TRIGGER "TR_publications_immutable" ON publications;
            CREATE TRIGGER "TR_publications_immutable"
                BEFORE UPDATE OR DELETE ON publications
                FOR EACH ROW EXECUTE FUNCTION reject_publication_update();
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DROP TRIGGER "TR_publications_immutable" ON publications;
            CREATE TRIGGER "TR_publications_immutable"
                BEFORE UPDATE ON publications
                FOR EACH ROW EXECUTE FUNCTION reject_publication_update();

            CREATE OR REPLACE FUNCTION reject_publication_update() RETURNS trigger
            LANGUAGE plpgsql AS $immutable$
            BEGIN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    CONSTRAINT = 'CK_publications_immutable',
                    MESSAGE = 'Publication snapshots cannot be updated.';
            END;
            $immutable$;
            """);
    }
}
