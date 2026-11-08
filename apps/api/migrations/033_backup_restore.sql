CREATE TABLE backup_restores (
 manifest_hash text PRIMARY KEY CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('full','platform')),
 storage_root text NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 report jsonb NOT NULL
);
-- Preserve subscription visibility for pending events across PostgreSQL clusters.
CREATE TABLE backup_notification_eligibility (
 event_id bigint REFERENCES archive_outbox,
 user_id uuid REFERENCES users,
 kind text NOT NULL,
 target text NOT NULL,
 subscription_created_at timestamptz NOT NULL,
 PRIMARY KEY(event_id,user_id,kind,target,subscription_created_at)
);
