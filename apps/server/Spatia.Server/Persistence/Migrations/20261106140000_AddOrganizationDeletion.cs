using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Spatia.Server.Persistence.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261106140000_AddOrganizationDeletion")]
public sealed class AddOrganizationDeletion : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            -- Keep only opaque retired URL identities, never deleted content or account details.
            CREATE TABLE retired_publication_ids (id uuid PRIMARY KEY);
            CREATE FUNCTION organization_purge_matches(target_project uuid) RETURNS boolean
            LANGUAGE plpgsql STABLE AS $$
            DECLARE purge_organization text := current_setting('spatia.purge_organization', true);
            BEGIN
                -- Ordinary history guards do not need any additional table privileges.
                IF purge_organization IS NULL OR purge_organization = '' THEN RETURN false; END IF;
                RETURN EXISTS (SELECT 1 FROM projects WHERE id = target_project
                    AND organization_id::text = purge_organization);
            END;
            $$;

            CREATE OR REPLACE FUNCTION reject_publication_update() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_OP = 'DELETE' AND organization_purge_matches(OLD.project_id) THEN
                    INSERT INTO retired_publication_ids (id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
                    RETURN OLD;
                END IF;
                RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_publications_immutable',
                    MESSAGE = 'Publication snapshots cannot be updated or deleted.';
            END;
            $$;
            CREATE FUNCTION protect_retired_publication_id() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_TABLE_NAME = 'retired_publication_ids' OR EXISTS (SELECT 1 FROM retired_publication_ids WHERE id = NEW.id) THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_publication_id_retired',
                        MESSAGE = 'A retired publication identity cannot be reused or removed.';
                END IF;
                RETURN NEW;
            END;
            $$;
            -- Run after the unique ID check, including inserts that waited for a concurrent purge.
            CREATE TRIGGER "TR_publications_retired_id" AFTER INSERT ON publications
                FOR EACH ROW EXECUTE FUNCTION protect_retired_publication_id();
            CREATE TRIGGER "TR_retired_publication_ids_immutable" BEFORE UPDATE OR DELETE ON retired_publication_ids
                FOR EACH ROW EXECUTE FUNCTION protect_retired_publication_id();

            CREATE OR REPLACE FUNCTION retain_publication_access_deletion() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM publications
                    WHERE id = OLD."PublicationId" AND organization_purge_matches(project_id)) THEN
                    RETURN OLD;
                END IF;
                IF TG_OP = 'DELETE' OR (OLD."Deleted" AND NOT NEW."Deleted") THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_publication_access_permanent',
                        MESSAGE = 'Publication deletion cannot be reversed or replaced.';
                END IF;
                RETURN NEW;
            END;
            $$;
            CREATE OR REPLACE FUNCTION reject_review_evidence_change() RETURNS trigger
            LANGUAGE plpgsql AS $$
            DECLARE target_project uuid;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    IF TG_TABLE_NAME = 'review_submissions' THEN target_project := OLD.project_id;
                    ELSE SELECT project_id INTO target_project FROM review_submissions WHERE id = OLD.submission_id;
                    END IF;
                    IF organization_purge_matches(target_project) THEN RETURN OLD; END IF;
                END IF;
                RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_review_evidence_immutable',
                    MESSAGE = 'Review evidence cannot be changed.';
            END;
            $$;
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // A downgrade must not make a previously deleted public URL reusable.
        migrationBuilder.Sql("""
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM retired_publication_ids) THEN
                    RAISE EXCEPTION 'Retired publication identities must be retained; review the downgrade first.';
                END IF;
            END $$;
            DROP TRIGGER "TR_publications_retired_id" ON publications;
            DROP TABLE retired_publication_ids;
            DROP FUNCTION protect_retired_publication_id();
            CREATE OR REPLACE FUNCTION reject_publication_update() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_publications_immutable',
                    MESSAGE = 'Publication snapshots cannot be updated or deleted.';
            END $$;
            CREATE OR REPLACE FUNCTION reject_review_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_review_evidence_immutable',
                    MESSAGE = 'Review evidence cannot be changed.';
            END $$;
            CREATE OR REPLACE FUNCTION retain_publication_access_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_OP = 'DELETE' OR (OLD."Deleted" AND NOT NEW."Deleted") THEN
                    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'CK_publication_access_permanent',
                        MESSAGE = 'Publication deletion cannot be reversed or replaced.';
                END IF;
                RETURN NEW;
            END $$;
            DROP FUNCTION organization_purge_matches(uuid);
            """);
    }
}
