ALTER TABLE ingest_batches ADD COLUMN reconcile_batch_id uuid REFERENCES ingest_batches;
