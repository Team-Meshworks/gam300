using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261109000000_AddDevelopmentPublicationAssets")]
public sealed class AddDevelopmentPublicationAssets : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            CREATE TABLE development_publication_blobs (
                sha256 text PRIMARY KEY CHECK (sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
                bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 104857600)
            );
            CREATE TABLE development_publication_assets (
                publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE RESTRICT,
                asset_id text NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 256),
                kind text NOT NULL CHECK (kind IN ('environment', 'model', 'image', 'audio', 'video')),
                media_type text NOT NULL CHECK (media_type IN ('model/gltf-binary', 'image/webp', 'audio/mp4', 'video/webm')),
                sha256 text NOT NULL REFERENCES development_publication_blobs(sha256) ON DELETE RESTRICT,
                placement text CHECK (placement IS NULL OR (placement = 'bottom-center' AND kind IN ('environment', 'model'))),
                PRIMARY KEY (publication_id, asset_id)
            );
            CREATE FUNCTION reject_development_publication_asset_change() RETURNS trigger
            LANGUAGE plpgsql AS $immutable$
            BEGIN
                IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'development_publication_assets' THEN
                    IF EXISTS (SELECT 1 FROM publications
                        WHERE id = OLD.publication_id AND organization_purge_matches(project_id)) THEN
                        RETURN OLD;
                    END IF;
                END IF;
                RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_development_publication_assets_immutable',
                    MESSAGE = 'Captured development assets are immutable.';
            END;
            $immutable$;
            CREATE TRIGGER "TR_development_publication_blobs_immutable" BEFORE UPDATE OR DELETE ON development_publication_blobs
                FOR EACH ROW EXECUTE FUNCTION reject_development_publication_asset_change();
            CREATE TRIGGER "TR_development_publication_assets_immutable" BEFORE UPDATE OR DELETE ON development_publication_assets
                FOR EACH ROW EXECUTE FUNCTION reject_development_publication_asset_change();
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DO $guard$ BEGIN
                IF EXISTS (SELECT 1 FROM development_publication_assets) OR EXISTS (SELECT 1 FROM development_publication_blobs) THEN
                    RAISE EXCEPTION 'Cannot remove retained development publication assets.';
                END IF;
            END $guard$;
            DROP TABLE development_publication_assets;
            DROP TABLE development_publication_blobs;
            DROP FUNCTION reject_development_publication_asset_change();
            """);
    }
}
