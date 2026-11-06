ALTER TABLE ingest_sources ADD COLUMN checkpoint_detail jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ingest_sources ALTER COLUMN parser SET DEFAULT 'ao3-dump-4';
