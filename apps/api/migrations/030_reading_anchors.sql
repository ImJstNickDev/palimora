CREATE TABLE library_progress (
 user_id uuid REFERENCES users, work_id uuid REFERENCES archive_work_heads,
 revision integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'to_read' CHECK(state IN ('to_read','reading','completed','paused','abandoned')),
 anchor jsonb, percent double precision NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
 PRIMARY KEY(user_id,work_id)
);
CREATE TABLE library_progress_versions (
 user_id uuid REFERENCES users, work_id uuid REFERENCES archive_work_heads, revision integer NOT NULL,
 anchor jsonb, state text NOT NULL, percent double precision NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,work_id,revision)
);
CREATE TABLE library_annotations (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users,work_id uuid NOT NULL REFERENCES archive_work_heads,
 collection_id uuid REFERENCES library_collections, anchor jsonb NOT NULL, body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
 revision integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX library_annotations_work ON library_annotations(work_id,id);
CREATE TABLE library_annotation_versions (
 id uuid REFERENCES library_annotations, revision integer NOT NULL, anchor jsonb NOT NULL,body text NOT NULL,
 collection_id uuid REFERENCES library_collections,deleted boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(id,revision)
);
CREATE TRIGGER progress_version_immutable BEFORE UPDATE OR DELETE ON library_progress_versions FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TRIGGER annotation_version_immutable BEFORE UPDATE OR DELETE ON library_annotation_versions FOR EACH ROW EXECUTE FUNCTION archive_immutable();
