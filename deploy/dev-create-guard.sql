\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '30s';
\if :pause
CREATE SCHEMA IF NOT EXISTS spatia_dev_cutover;
CREATE OR REPLACE FUNCTION spatia_dev_cutover.reject_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Development creates are temporarily paused' USING ERRCODE = '55000';
END
$$;

SELECT format(
    'CREATE OR REPLACE TRIGGER spatia_dev_pause_create BEFORE INSERT ON %1$s
     FOR EACH STATEMENT EXECUTE FUNCTION spatia_dev_cutover.reject_insert();
     ALTER TABLE %1$s ENABLE ALWAYS TRIGGER spatia_dev_pause_create', relation)
FROM (VALUES (to_regclass('public.projects')), (to_regclass('public.classrooms'))) AS targets(relation)
WHERE relation IS NOT NULL
\gexec
DO $$
DECLARE target regclass;
BEGIN
    FOR target IN SELECT unnest(ARRAY[to_regclass('public.projects'), to_regclass('public.classrooms')]) LOOP
        IF target IS NOT NULL THEN
            BEGIN
                EXECUTE format('INSERT INTO %s (id) SELECT NULL::uuid WHERE false', target);
                RAISE EXCEPTION 'Create guard missing on %', target;
            EXCEPTION WHEN SQLSTATE '55000' THEN
                IF SQLERRM <> 'Development creates are temporarily paused' THEN RAISE; END IF;
            END;
        END IF;
    END LOOP;
END
$$;
\else
DROP TRIGGER spatia_dev_pause_create ON public.projects;
DROP TRIGGER spatia_dev_pause_create ON public.classrooms;
DROP FUNCTION spatia_dev_cutover.reject_insert();
DROP SCHEMA spatia_dev_cutover;
SAVEPOINT write_probe;
SET LOCAL ROLE spatia_api;
INSERT INTO public.projects (id) SELECT NULL::uuid WHERE false;
INSERT INTO public.classrooms (id) SELECT NULL::uuid WHERE false;
ROLLBACK TO SAVEPOINT write_probe;
\endif
COMMIT;
