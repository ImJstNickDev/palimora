-- Receipts beyond a hole survive a worker restart. Only a contiguous prefix
-- contributes counters/checkpoints; catalog effects are already durable.
CREATE TABLE ingest_progress (
 source_id uuid NOT NULL REFERENCES ingest_sources ON DELETE CASCADE,
 fingerprint text NOT NULL, start_key text NOT NULL, end_key text NOT NULL,
 cursor bigint NOT NULL, detail jsonb NOT NULL,
 imported bigint NOT NULL, duplicates bigint NOT NULL, bytes bigint NOT NULL, gaps bigint NOT NULL,
 PRIMARY KEY(source_id,fingerprint,end_key), UNIQUE(source_id,fingerprint,start_key),
 CHECK(start_key <> end_key)
);
-- New values use LZ4; immutable historical rows need no rewrite.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid
 WHERE n.nspname=current_schema() AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
 AND a.atttypid='jsonb'::regtype AND (c.relname LIKE 'archive_%' OR c.relname LIKE 'ingest_%')
 LOOP EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET COMPRESSION lz4',r.relname,r.attname); END LOOP;
END $$;
