CREATE TABLE ao3_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode text NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto','force_online','force_offline')),
 paused boolean NOT NULL DEFAULT false,
 observed_state text NOT NULL DEFAULT 'unknown' CHECK(observed_state IN ('online','maintenance','rate_limited','blocked','unreachable','unknown')),
 checked_at timestamptz,
 next_probe_at timestamptz NOT NULL DEFAULT now(),
 cooldown_until timestamptz,
 failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ao3_control(singleton) VALUES(true);
CREATE TABLE ao3_health_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL,
 http_status integer,
 retry_at timestamptz,
 duration_ms integer NOT NULL CHECK(duration_ms>=0)
);
CREATE TABLE ao3_watch (
 work_id uuid PRIMARY KEY REFERENCES archive_work_heads(id),
 last_open_at timestamptz NOT NULL,
 watch_until timestamptz NOT NULL,
 next_due_at timestamptz NOT NULL,
 last_started_at timestamptz,
 availability text NOT NULL DEFAULT 'unknown' CHECK(availability IN ('available','deleted','hidden_or_restricted','temporarily_unavailable','unknown'))
);
CREATE INDEX ao3_watch_due ON ao3_watch(next_due_at) WHERE availability <> 'deleted';
