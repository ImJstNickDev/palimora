-- Run on a disposable cloned database only. Kept separate from migrations.
BEGIN;
CREATE TABLE storage_probe_tags AS SELECT id,row_number() OVER(ORDER BY id)::bigint AS internal_id FROM catalog_tags;
ALTER TABLE storage_probe_tags ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX ON storage_probe_tags(internal_id);
CREATE TABLE storage_probe_compact AS SELECT w.work_id,t.internal_id AS tag_id FROM catalog_work_tags w JOIN storage_probe_tags t ON t.id=w.tag_id;
CREATE TABLE storage_probe_text AS SELECT * FROM catalog_work_tags;
ALTER TABLE storage_probe_compact ADD PRIMARY KEY(work_id,tag_id);
CREATE INDEX ON storage_probe_compact(tag_id,work_id);
ALTER TABLE storage_probe_text ADD PRIMARY KEY(work_id,tag_id);
CREATE INDEX ON storage_probe_text(tag_id,work_id);
SELECT json_build_object('compact',pg_total_relation_size('storage_probe_compact'),'text',pg_total_relation_size('storage_probe_text'),'mapping',pg_total_relation_size('storage_probe_tags'));
ROLLBACK;
