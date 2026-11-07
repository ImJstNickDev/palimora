CREATE TABLE library_bookmarks (
 user_id uuid NOT NULL REFERENCES users, work_id uuid NOT NULL REFERENCES archive_work_heads,
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=10000), tags text[] NOT NULL DEFAULT '{}',
 recommended boolean NOT NULL DEFAULT false, private boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), deleted boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,work_id),
 CHECK(cardinality(tags)<=50)
);
CREATE TABLE library_readings (
 user_id uuid NOT NULL REFERENCES users, work_id uuid NOT NULL REFERENCES archive_work_heads,
 later boolean NOT NULL DEFAULT false, last_viewed timestamptz, PRIMARY KEY(user_id,work_id)
);
CREATE INDEX library_bookmark_tags ON library_bookmarks USING gin(tags);
CREATE INDEX library_history ON library_readings(user_id,last_viewed DESC,work_id);
