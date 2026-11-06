ALTER TABLE ingest_issues ADD COLUMN fingerprint text NOT NULL DEFAULT '';
ALTER TABLE ingest_issues DROP CONSTRAINT ingest_issues_source_id_locator_code_key;
ALTER TABLE ingest_issues ADD UNIQUE(source_id,fingerprint,locator,code);
