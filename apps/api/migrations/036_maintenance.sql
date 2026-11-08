ALTER TABLE instance ADD COLUMN maintenance_mode text NOT NULL DEFAULT 'normal' CHECK(maintenance_mode IN('normal','maintenance_light','maintenance_full'));
ALTER TABLE sessions ADD COLUMN parent_session_id uuid REFERENCES sessions, ADD COLUMN actor_admin_id uuid REFERENCES users;
ALTER TABLE sessions ADD CONSTRAINT impersonation_session CHECK ((parent_session_id IS NULL) = (actor_admin_id IS NULL));
CREATE INDEX sessions_parent ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
ALTER TABLE archive_jobs DROP CONSTRAINT archive_jobs_kind_check;
ALTER TABLE archive_jobs ADD CONSTRAINT archive_jobs_kind_check CHECK(kind IN('compact','collect','reset_dev','scrub','repair'));
ALTER TABLE archive_jobs ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}', ADD COLUMN progress jsonb NOT NULL DEFAULT '{}', ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN started_at timestamptz, ADD COLUMN finished_at timestamptz, ADD COLUMN actor_id uuid REFERENCES users;
CREATE TABLE integrity_schedule(id boolean PRIMARY KEY DEFAULT true CHECK(id),enabled boolean NOT NULL DEFAULT false,every_days integer NOT NULL DEFAULT 30 CHECK(every_days BETWEEN 1 AND 365),next_at timestamptz NOT NULL DEFAULT now()+interval '30 days',actor_id uuid REFERENCES users);
INSERT INTO integrity_schedule(id) VALUES(true);
CREATE TABLE integrity_issues(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL REFERENCES archive_jobs,identity text NOT NULL,object_hash text,pack text,code text NOT NULL,state text NOT NULL DEFAULT 'open' CHECK(state IN('open','repaired','unrecoverable')),detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),repair_job_id uuid REFERENCES archive_jobs,UNIQUE(job_id,identity,code));
CREATE INDEX integrity_issues_job ON integrity_issues(job_id,created_at,id);
CREATE INDEX integrity_issues_hash ON integrity_issues(object_hash) WHERE state<>'repaired';
CREATE TABLE integrity_packs(job_id uuid REFERENCES archive_jobs,pack text NOT NULL,state text NOT NULL DEFAULT 'pending',PRIMARY KEY(job_id,pack));
CREATE INDEX audit_recent ON audit(created_at DESC,id DESC);
CREATE INDEX audit_actor ON audit(actor_id,id DESC);
CREATE OR REPLACE VIEW operations_jobs AS
 SELECT 'ingest'::text AS family,b.id::text AS id,'ingest'::text AS kind,b.state,b.created_at,b.updated_at,
 NULL::integer AS priority,CASE WHEN b.error IS NULL THEN NULL ELSE 'INGEST_FAILED' END AS error,
 jsonb_build_object('phase',b.state) AS progress FROM ingest_batches b WHERE source_kind='dump'
 UNION ALL SELECT CASE WHEN kind='media' THEN 'media' ELSE 'sync' END,id::text,kind,state,created_at,greatest(checked_at,started_at,created_at),priority,error,jsonb_build_object('attempts',attempts,'due_at',due_at) FROM ao3_jobs
 UNION ALL SELECT 'backup',id::text,kind,state,created_at,updated_at,NULL,error,progress FROM backup_runs
 UNION ALL SELECT 'admin',id::text,kind,state,created_at,updated_at,NULL,CASE WHEN state='failed' THEN coalesce(result->>'code','OPERATION_FAILED') END,CASE WHEN kind IN('scrub','repair') THEN progress ELSE coalesce(result,'{}')-'error'-'message' END FROM archive_jobs
 UNION ALL SELECT 'index',kind,kind,CASE WHEN paused AND state='running' THEN 'pause_requested' WHEN paused THEN 'paused' ELSE state END,updated_at,updated_at,NULL,error,jsonb_build_object('processed',processed,'retry_at',retry_at) FROM operations_index;
