CREATE TABLE ingest_batches (
 id uuid PRIMARY KEY, state text NOT NULL CHECK(state IN ('pending','scanning','running','parser_blocked','paused','completed','completed_with_gaps','failed_global')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), error jsonb, reprocess boolean NOT NULL DEFAULT false
);
CREATE TABLE ingest_sources (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES ingest_batches, path text NOT NULL, fingerprint text NOT NULL,
 state text NOT NULL, checkpoint bigint NOT NULL DEFAULT 0, imported bigint NOT NULL DEFAULT 0, gaps bigint NOT NULL DEFAULT 0, error jsonb,
 UNIQUE(batch_id,path)
);
CREATE TABLE archive_objects (
 hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'), pack text NOT NULL, byte_offset bigint NOT NULL, length bigint NOT NULL, size bigint NOT NULL, kind text NOT NULL
);
CREATE TABLE archive_works (
 id uuid PRIMARY KEY, external_id text UNIQUE, provisional_key text UNIQUE, metadata jsonb NOT NULL DEFAULT '{}', current_snapshot_id uuid, head_reason text NOT NULL DEFAULT 'no_valid_snapshot'
);
CREATE TABLE archive_snapshots (
 id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES archive_works, manifest_hash text NOT NULL REFERENCES archive_objects,
 state text NOT NULL CHECK(state IN ('metadata_only','partial','valid')), observed_at timestamptz, imported_at timestamptz NOT NULL DEFAULT now(), ordering_uncertain boolean NOT NULL DEFAULT true
);
ALTER TABLE archive_works ADD CONSTRAINT archive_head_fk FOREIGN KEY(current_snapshot_id) REFERENCES archive_snapshots;
CREATE INDEX archive_snapshots_work ON archive_snapshots(work_id,id);
CREATE TABLE archive_records (
 source_path text NOT NULL, fingerprint text NOT NULL, locator text NOT NULL, parser text NOT NULL, result_hash text NOT NULL,
 work_id uuid NOT NULL REFERENCES archive_works, snapshot_id uuid REFERENCES archive_snapshots, evidence jsonb NOT NULL,
 PRIMARY KEY(source_path,fingerprint,locator,parser,result_hash)
);
CREATE INDEX archive_records_work ON archive_records(work_id);
CREATE TABLE archive_outbox (id bigserial PRIMARY KEY, event text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable archive history'; END $$;
CREATE TRIGGER snapshot_immutable BEFORE UPDATE OR DELETE ON archive_snapshots FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TRIGGER record_immutable BEFORE UPDATE OR DELETE ON archive_records FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TRIGGER outbox_immutable BEFORE UPDATE OR DELETE ON archive_outbox FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE FUNCTION archive_valid_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.current_snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM archive_snapshots WHERE id=NEW.current_snapshot_id AND work_id=NEW.id AND state='valid') THEN RAISE EXCEPTION 'invalid head'; END IF; RETURN NEW; END $$;
CREATE TRIGGER valid_head BEFORE INSERT OR UPDATE ON archive_works FOR EACH ROW EXECUTE FUNCTION archive_valid_head();
CREATE TABLE ingest_issues (
 id bigserial PRIMARY KEY, source_id uuid NOT NULL REFERENCES ingest_sources, locator text NOT NULL, code text NOT NULL, detail jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,locator,code)
);
