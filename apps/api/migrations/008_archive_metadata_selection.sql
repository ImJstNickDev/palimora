CREATE TABLE archive_field_selection(work_id uuid NOT NULL REFERENCES archive_works,field text NOT NULL,confidence text NOT NULL,source_path text NOT NULL,locator text NOT NULL,reason text NOT NULL,PRIMARY KEY(work_id,field));
INSERT INTO archive_field_selection(work_id,field,confidence,source_path,locator,reason)
SELECT DISTINCT ON(e.work_id,e.field) e.work_id,e.field,e.confidence,e.source_path,e.locator,'existing_selected_evidence'
FROM archive_field_evidence e JOIN archive_works w ON w.id=e.work_id AND w.metadata->e.field=e.value
ORDER BY e.work_id,e.field,CASE e.confidence WHEN 'document' THEN 0 ELSE 1 END,e.source_path,e.locator;
