-- Historical acquisitions retain their parser and immutable bytes.
ALTER TABLE ingest_sources ALTER COLUMN parser SET DEFAULT 'ao3-dump-5';
