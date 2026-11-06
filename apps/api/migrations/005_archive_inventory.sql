CREATE TABLE ingest_inventory(path text PRIMARY KEY,size bigint NOT NULL,state text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE archive_admin_requests(id uuid PRIMARY KEY,result jsonb NOT NULL);
