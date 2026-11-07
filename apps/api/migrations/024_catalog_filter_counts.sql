CREATE TABLE catalog_work_filters(work_id uuid NOT NULL REFERENCES archive_work_heads,tag_id text NOT NULL REFERENCES catalog_tags,PRIMARY KEY(work_id,tag_id));
CREATE INDEX catalog_filter_work ON catalog_work_filters(tag_id,work_id);
INSERT INTO catalog_work_filters SELECT d.work_id,t.id FROM catalog_documents d CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(d.bibliography->'filterTags','[]')) f(id) JOIN catalog_tags t ON t.id=f.id ON CONFLICT DO NOTHING;
DROP INDEX catalog_search;
