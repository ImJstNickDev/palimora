CREATE TABLE ingest_results (
 source_id uuid NOT NULL REFERENCES ingest_sources,
 fingerprint text NOT NULL, locator text NOT NULL, parser text NOT NULL, result_hash text NOT NULL,
 work_id uuid NOT NULL REFERENCES archive_works, snapshot_id uuid REFERENCES archive_snapshots,
 PRIMARY KEY(source_id,fingerprint,locator,parser,result_hash)
);
INSERT INTO ingest_results(source_id,fingerprint,locator,parser,result_hash,work_id,snapshot_id)
 SELECT s.id,r.fingerprint,r.locator,r.parser,r.result_hash,r.work_id,r.snapshot_id
 FROM ingest_sources s JOIN archive_records r ON r.source_path=s.path AND r.fingerprint=s.fingerprint AND r.parser=s.parser;
CREATE TRIGGER ingest_result_immutable BEFORE UPDATE OR DELETE ON ingest_results FOR EACH ROW EXECUTE FUNCTION archive_immutable();
