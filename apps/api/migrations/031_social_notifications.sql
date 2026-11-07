-- Preserve existing events; only future outbox inserts acquire a producer transaction.
ALTER TABLE archive_outbox ADD COLUMN producer_xid xid8;
ALTER TABLE archive_outbox ALTER COLUMN producer_xid SET DEFAULT pg_current_xact_id();
CREATE INDEX personal_pending_events ON archive_outbox(id) WHERE producer_xid IS NOT NULL AND event='work.snapshot.published';
CREATE SEQUENCE personal_notification_bucket;
CREATE TABLE personal_settings (
 user_id uuid PRIMARY KEY REFERENCES users,
 activity text NOT NULL DEFAULT 'private' CHECK(activity IN ('private','selected','instance')),
 statistics text NOT NULL DEFAULT 'private' CHECK(statistics IN ('private','selected','instance')),
 activity_users uuid[] NOT NULL DEFAULT '{}', statistics_users uuid[] NOT NULL DEFAULT '{}',
 recommendations boolean NOT NULL DEFAULT true, updates boolean NOT NULL DEFAULT true,
 push boolean NOT NULL DEFAULT false, grouping integer NOT NULL DEFAULT 300 CHECK(grouping IN (0,300,3600)),
 revision integer NOT NULL DEFAULT 0
);
CREATE TABLE reading_heartbeat(session_id uuid PRIMARY KEY REFERENCES sessions,work_id uuid REFERENCES archive_work_heads,last_at timestamptz NOT NULL);
CREATE TABLE reading_intervals(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users,work_id uuid NOT NULL REFERENCES archive_work_heads,span tstzrange NOT NULL);
CREATE INDEX reading_interval_user ON reading_intervals(user_id);
CREATE TABLE personal_subscriptions(user_id uuid REFERENCES users,kind text CHECK(kind IN ('work','author','series')),target text NOT NULL,mode text NOT NULL CHECK(mode IN ('chapters','changes')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),start_snapshot pg_snapshot NOT NULL DEFAULT pg_current_snapshot(),PRIMARY KEY(user_id,kind,target));
CREATE TABLE personal_recommendations(id uuid PRIMARY KEY,sender_id uuid NOT NULL REFERENCES users,recipient_id uuid NOT NULL REFERENCES users,work_id uuid NOT NULL REFERENCES archive_work_heads,note text NOT NULL CHECK(length(note)<=2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(sender_id,recipient_id,work_id),CHECK(sender_id<>recipient_id));
CREATE TABLE personal_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,kind text NOT NULL CHECK(kind IN ('update','recommendation')),work_id uuid NOT NULL REFERENCES archive_work_heads,source_id uuid,bucket bigint NOT NULL,versions integer NOT NULL DEFAULT 1,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE UNIQUE INDEX notification_update_group ON personal_notifications(user_id,work_id,bucket) WHERE kind='update';
CREATE UNIQUE INDEX notification_recommendation ON personal_notifications(source_id) WHERE kind='recommendation';
CREATE INDEX notification_user ON personal_notifications(user_id,id);
CREATE TABLE personal_notification_versions(user_id uuid REFERENCES users,work_id uuid REFERENCES archive_work_heads,snapshot_id uuid REFERENCES archive_snapshot_data,PRIMARY KEY(user_id,work_id,snapshot_id));
CREATE TABLE personal_event_receipts(event_id bigint PRIMARY KEY REFERENCES archive_outbox);
CREATE TABLE personal_runtime(id boolean PRIMARY KEY DEFAULT true CHECK(id),started_at timestamptz NOT NULL DEFAULT clock_timestamp(),public_key text,private_key text);
INSERT INTO personal_runtime(id) VALUES(true);
CREATE TABLE push_devices(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users,session_id uuid NOT NULL REFERENCES sessions,endpoint_hash text NOT NULL UNIQUE,subscription text NOT NULL,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_error text);
CREATE TABLE push_deliveries(notification_id uuid REFERENCES personal_notifications,device_id uuid REFERENCES push_devices ON DELETE CASCADE,generation integer NOT NULL,sent_generation integer NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,next_at timestamptz NOT NULL,failed boolean NOT NULL DEFAULT false,PRIMARY KEY(notification_id,device_id));
CREATE INDEX push_due ON push_deliveries(next_at) WHERE NOT failed;
