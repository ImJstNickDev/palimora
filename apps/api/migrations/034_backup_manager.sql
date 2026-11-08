CREATE TABLE backup_destinations (
 name text PRIMARY KEY, label text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 health jsonb NOT NULL DEFAULT '{}', checked_at timestamptz
);
CREATE TABLE backup_schedules (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('full','platform','export')),
 destination text NOT NULL REFERENCES backup_destinations, enabled boolean NOT NULL DEFAULT false,
 every_hours integer NOT NULL CHECK(every_hours BETWEEN 1 AND 8760), keep integer NOT NULL CHECK(keep BETWEEN 1 AND 1000),
 next_at timestamptz NOT NULL, created_by uuid NOT NULL REFERENCES users
);
CREATE TABLE backup_runs (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('full','platform','export','verify','restore','delete')),
 destination text NOT NULL REFERENCES backup_destinations,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','pause_requested','paused','cancel_requested','cancelled','completed','failed','deleted')),
 source_id uuid REFERENCES backup_runs, base_id uuid REFERENCES backup_runs,
 restore_target text, confirmation text,
 schedule_id uuid REFERENCES backup_schedules, actor_id uuid REFERENCES users,
 progress jsonb NOT NULL DEFAULT '{}', result jsonb NOT NULL DEFAULT '{}', error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 verified_at timestamptz, generation integer NOT NULL DEFAULT 0
);
CREATE INDEX backup_runs_pending ON backup_runs(created_at) WHERE state IN ('pending','running','pause_requested','cancel_requested');
CREATE TABLE archive_import_receipts(manifest_hash text PRIMARY KEY,result jsonb NOT NULL);
