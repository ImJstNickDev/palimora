ALTER TABLE ao3_control ADD COLUMN next_request_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN spacing_ms integer NOT NULL DEFAULT 10000 CHECK(spacing_ms BETWEEN 10000 AND 3600000),
 ADD COLUMN credentials text, ADD COLUMN cookies text, ADD COLUMN auth_state text NOT NULL DEFAULT 'anonymous',
 ADD COLUMN priorities jsonb NOT NULL DEFAULT '{"discovery":10,"work":30,"entity":40,"media":50,"backfill":80}',
 ADD COLUMN seed_cursor uuid, ADD COLUMN seed_complete boolean NOT NULL DEFAULT false;
CREATE TABLE ao3_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('discovery','backfill','work','entity','media')),
 target text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry','idle','blocked')),
 priority integer NOT NULL DEFAULT 30 CHECK(priority BETWEEN 1 AND 100),
 due_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz, checked_at timestamptz, last_changed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, generation integer NOT NULL DEFAULT 0,
 checkpoint jsonb NOT NULL DEFAULT '{}', error text,
 availability text NOT NULL DEFAULT 'unknown', complete boolean,
 UNIQUE(kind,target)
);
CREATE INDEX ao3_jobs_due ON ao3_jobs(due_at,priority) WHERE state IN ('pending','retry','idle');
CREATE TABLE ao3_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES ao3_jobs,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, outcome text NOT NULL DEFAULT 'running',
 detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ao3_runs_job ON ao3_runs(job_id,id DESC);
CREATE TABLE ao3_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES ao3_jobs,
 observed_at timestamptz NOT NULL DEFAULT now(), result_hash text, snapshot_id uuid REFERENCES archive_snapshot_data,
 availability text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'
);
CREATE TRIGGER ao3_observation_immutable BEFORE UPDATE OR DELETE ON ao3_observations FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TABLE ao3_media (
 url text PRIMARY KEY, object_hash text, object_kind text, mime text,
 checked_at timestamptz, failures integer NOT NULL DEFAULT 0
);
CREATE TABLE ao3_media_revisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, url text NOT NULL REFERENCES ao3_media,
 hash text NOT NULL, kind text NOT NULL, acquired_at timestamptz NOT NULL DEFAULT now(), mime text
);
CREATE TRIGGER ao3_media_immutable BEFORE UPDATE OR DELETE ON ao3_media_revisions FOR EACH ROW EXECUTE FUNCTION archive_immutable();
INSERT INTO ao3_jobs(kind,target,priority) VALUES ('discovery','recent',10),('backfill','history',80);
ALTER TABLE ao3_control ADD COLUMN robots text, ADD COLUMN robots_checked_at timestamptz;
ALTER TABLE ingest_batches ADD COLUMN source_kind text NOT NULL DEFAULT 'dump' CHECK(source_kind IN ('dump','ao3'));
CREATE FUNCTION ao3_availability_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='work' AND (TG_OP='INSERT' OR OLD.availability IS DISTINCT FROM NEW.availability) THEN
  INSERT INTO catalog_pending SELECT id FROM archive_work_heads WHERE external_id=NEW.target ON CONFLICT DO NOTHING;
 END IF; RETURN NULL; END $$;
CREATE TRIGGER ao3_availability_changed AFTER INSERT OR UPDATE OF availability ON ao3_jobs FOR EACH ROW EXECUTE FUNCTION ao3_availability_changed();
CREATE TABLE ao3_media_hosts(host text PRIMARY KEY,next_request_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ao3_uploads(id uuid PRIMARY KEY, url text NOT NULL, size bigint NOT NULL CHECK(size>=0), received bigint NOT NULL DEFAULT 0,
 mime text NOT NULL, state text NOT NULL DEFAULT 'receiving' CHECK(state IN ('receiving','queued','completed')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ao3_upload_chunks(upload_id uuid NOT NULL REFERENCES ao3_uploads ON DELETE CASCADE, byte_offset bigint NOT NULL, data bytea NOT NULL, PRIMARY KEY(upload_id,byte_offset));
