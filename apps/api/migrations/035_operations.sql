CREATE TABLE operations_layout(user_id uuid PRIMARY KEY REFERENCES users,sections text[] NOT NULL);
CREATE TABLE operations_metrics (
 bucket timestamptz NOT NULL,step integer NOT NULL CHECK(step IN(60,3600)),
 series text NOT NULL,metric text NOT NULL,n bigint NOT NULL,total double precision NOT NULL,
 peak double precision NOT NULL,last double precision NOT NULL,
 PRIMARY KEY(step,bucket,series,metric)
);
CREATE TABLE operations_http (
 bucket timestamptz NOT NULL,step integer NOT NULL CHECK(step IN(60,3600)),kind text NOT NULL CHECK(kind IN('api','search')),
 requests bigint NOT NULL,errors bigint NOT NULL,total_ms double precision NOT NULL,max_ms double precision NOT NULL,histogram bigint[] NOT NULL,
 PRIMARY KEY(step,bucket,kind)
);
CREATE FUNCTION operations_histogram_add(a bigint[],b bigint[]) RETURNS bigint[] LANGUAGE sql IMMUTABLE AS $$
 SELECT array_agg(coalesce(a[i],0)+coalesce(b[i],0) ORDER BY i) FROM generate_series(1,greatest(cardinality(a),cardinality(b))) i
$$;
CREATE TABLE operations_status(name text PRIMARY KEY,checked_at timestamptz NOT NULL DEFAULT now(),value jsonb NOT NULL);
CREATE TABLE operations_index (
 kind text PRIMARY KEY CHECK(kind IN('catalog','search')),paused boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'idle',updated_at timestamptz NOT NULL DEFAULT now(),retry_at timestamptz,
 processed bigint NOT NULL DEFAULT 0,error text
);
INSERT INTO operations_index(kind) VALUES('catalog'),('search');
CREATE TABLE operations_index_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,kind text NOT NULL REFERENCES operations_index,
 started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT now(),processed integer NOT NULL,error text
);
CREATE INDEX operations_index_runs_recent ON operations_index_runs(finished_at DESC);
CREATE INDEX operations_ao3_created ON ao3_jobs(created_at DESC,id DESC);
CREATE INDEX operations_ao3_finished ON ao3_runs(finished_at) WHERE finished_at IS NOT NULL;
CREATE VIEW operations_jobs AS
 SELECT 'ingest'::text AS family,b.id::text AS id,'ingest'::text AS kind,b.state,b.created_at,b.updated_at,
 NULL::integer AS priority,CASE WHEN b.error IS NULL THEN NULL ELSE 'INGEST_FAILED' END AS error,
 jsonb_build_object('phase',b.state) AS progress FROM ingest_batches b WHERE source_kind='dump'
 UNION ALL SELECT CASE WHEN kind='media' THEN 'media' ELSE 'sync' END,id::text,kind,state,created_at,greatest(checked_at,started_at,created_at),priority,error,jsonb_build_object('attempts',attempts,'due_at',due_at) FROM ao3_jobs
 UNION ALL SELECT 'backup',id::text,kind,state,created_at,updated_at,NULL,error,progress FROM backup_runs
 UNION ALL SELECT 'admin',id::text,kind,state,created_at,created_at,NULL,CASE WHEN state='failed' THEN 'OPERATION_FAILED' END,coalesce(result,'{}')-'error' FROM archive_jobs
 UNION ALL SELECT 'index',kind,kind,CASE WHEN paused AND state='running' THEN 'pause_requested' WHEN paused THEN 'paused' ELSE state END,updated_at,updated_at,NULL,error,jsonb_build_object('processed',processed,'retry_at',retry_at) FROM operations_index;
