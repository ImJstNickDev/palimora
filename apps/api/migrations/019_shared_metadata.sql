-- Catalog payload identities are distinct from canonical pack hashes. Their
-- digest uses PostgreSQL's JSONB text representation in UTF-8 (catalog v1).
CREATE FUNCTION archive_payload_hash(value jsonb) RETURNS text
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;
CREATE TABLE archive_payloads (
 hash text PRIMARY KEY, value jsonb NOT NULL,
 CHECK(hash=archive_payload_hash(value))
);
ALTER TABLE archive_payloads ALTER COLUMN value SET COMPRESSION lz4;
CREATE TRIGGER payload_immutable BEFORE UPDATE OR DELETE ON archive_payloads FOR EACH ROW EXECUTE FUNCTION archive_immutable();
INSERT INTO archive_payloads SELECT archive_payload_hash(value),value FROM (
 SELECT '{}'::jsonb AS value UNION SELECT metadata FROM archive_works
 UNION SELECT evidence->'metadata' FROM archive_records
 UNION SELECT record->'metadata' FROM archive_parse_cache
 UNION SELECT coalesce((SELECT jsonb_object_agg(key,value->'value') FROM jsonb_each(o.fields)),'{}') FROM archive_observations o
) candidates WHERE value IS NOT NULL;
CREATE FUNCTION archive_intern_payload(value jsonb) RETURNS text LANGUAGE plpgsql AS $$
 DECLARE digest text:=archive_payload_hash(value); BEGIN
 INSERT INTO archive_payloads VALUES(digest,value) ON CONFLICT DO NOTHING;
 RETURN digest; END $$;

DROP VIEW archive_evidence_observations;
DROP VIEW archive_field_evidence;
ALTER TABLE archive_works RENAME TO archive_work_heads;
ALTER TABLE archive_work_heads ADD COLUMN metadata_hash text REFERENCES archive_payloads;
UPDATE archive_work_heads SET metadata_hash=archive_payload_hash(metadata);
ALTER TABLE archive_work_heads ALTER COLUMN metadata_hash SET NOT NULL;
ALTER TABLE archive_work_heads ALTER COLUMN metadata_hash SET DEFAULT archive_payload_hash('{}');

ALTER TABLE archive_observations RENAME TO archive_observation_data;
DROP TRIGGER observation_immutable ON archive_observation_data;
ALTER TABLE archive_observation_data ADD COLUMN payload_hash text REFERENCES archive_payloads;
ALTER TABLE archive_observation_data ADD COLUMN field_ids jsonb;
UPDATE archive_observation_data o SET
 payload_hash=archive_payload_hash(coalesce((SELECT jsonb_object_agg(key,value->'value') FROM jsonb_each(o.fields)),'{}')),
 field_ids=coalesce((SELECT jsonb_object_agg(key,value->'id') FROM jsonb_each(o.fields)),'{}');
ALTER TABLE archive_observation_data ALTER COLUMN payload_hash SET NOT NULL;
ALTER TABLE archive_observation_data ALTER COLUMN field_ids SET NOT NULL;
ALTER TABLE archive_observation_data ALTER COLUMN field_ids SET COMPRESSION lz4;

ALTER TABLE archive_records RENAME TO archive_record_data;
DROP TRIGGER record_immutable ON archive_record_data;
ALTER TABLE archive_record_data ADD COLUMN raw_metadata_hash text REFERENCES archive_payloads;
UPDATE archive_record_data SET raw_metadata_hash=archive_payload_hash(evidence->'metadata');
ALTER TABLE archive_parse_cache RENAME TO archive_cache_data;
DROP TRIGGER parse_cache_immutable ON archive_cache_data;
ALTER TABLE archive_cache_data ADD COLUMN raw_metadata_hash text REFERENCES archive_payloads;
UPDATE archive_cache_data SET raw_metadata_hash=archive_payload_hash(record->'metadata');

-- Check complete values and evidence IDs before removing the redundant copies.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM archive_work_heads w JOIN archive_payloads p ON p.hash=w.metadata_hash WHERE w.metadata IS DISTINCT FROM p.value)
 OR EXISTS(SELECT 1 FROM archive_observation_data o JOIN archive_payloads p ON p.hash=o.payload_hash WHERE o.fields IS DISTINCT FROM coalesce((SELECT jsonb_object_agg(key,jsonb_build_object('id',value,'value',p.value->key)) FROM jsonb_each(o.field_ids)),'{}'))
 OR EXISTS(SELECT 1 FROM archive_record_data r LEFT JOIN archive_payloads p ON p.hash=r.raw_metadata_hash WHERE r.evidence->'metadata' IS DISTINCT FROM p.value)
 OR EXISTS(SELECT 1 FROM archive_cache_data c LEFT JOIN archive_payloads p ON p.hash=c.raw_metadata_hash WHERE c.record->'metadata' IS DISTINCT FROM p.value)
 THEN RAISE EXCEPTION 'shared metadata migration mismatch'; END IF;
END $$;
ALTER TABLE archive_work_heads DROP COLUMN metadata;
ALTER TABLE archive_observation_data DROP COLUMN fields;
UPDATE archive_record_data SET evidence=evidence-'metadata';
UPDATE archive_cache_data SET record=record-'metadata';
CREATE TRIGGER observation_immutable BEFORE UPDATE OR DELETE ON archive_observation_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TRIGGER record_immutable BEFORE UPDATE OR DELETE ON archive_record_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TRIGGER parse_cache_immutable BEFORE UPDATE OR DELETE ON archive_cache_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();

CREATE VIEW archive_works AS
 SELECT w.id,w.external_id,w.provisional_key,p.value AS metadata,w.current_snapshot_id,w.head_reason
 FROM archive_work_heads w JOIN archive_payloads p ON p.hash=w.metadata_hash;
CREATE VIEW archive_observations AS
 SELECT o.id,o.work_id,o.source_path,o.locator,o.parser,o.fingerprint,
 coalesce((SELECT jsonb_object_agg(key,jsonb_build_object('id',value,'value',p.value->key)) FROM jsonb_each(o.field_ids)),'{}') AS fields
 FROM archive_observation_data o JOIN archive_payloads p ON p.hash=o.payload_hash;
CREATE VIEW archive_records AS
 SELECT r.source_path,r.fingerprint,r.locator,r.parser,r.result_hash,r.work_id,r.snapshot_id,
 r.evidence || CASE WHEN r.raw_metadata_hash IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('metadata',p.value) END AS evidence
 FROM archive_record_data r LEFT JOIN archive_payloads p ON p.hash=r.raw_metadata_hash;
CREATE VIEW archive_parse_cache AS
 SELECT c.source_hash,c.parser,c.record || CASE WHEN c.raw_metadata_hash IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('metadata',p.value) END AS record
 FROM archive_cache_data c LEFT JOIN archive_payloads p ON p.hash=c.raw_metadata_hash;
CREATE VIEW archive_evidence_observations AS
 SELECT f.value::bigint AS id,o.work_id,f.key AS field,p.value->f.key AS value,o.source_path,o.locator,o.parser,o.fingerprint
 FROM archive_observation_data o JOIN archive_payloads p ON p.hash=o.payload_hash CROSS JOIN LATERAL jsonb_each_text(o.field_ids) f;
CREATE VIEW archive_field_evidence AS
 SELECT r.work_id,f.key AS field,p.value->f.key AS value,r.source_path,r.locator,f.value->>'confidence' AS confidence
 FROM archive_evidence_refs r CROSS JOIN LATERAL jsonb_each(r.fields) f
 JOIN archive_observation_data o ON o.id=(f.value->>'observation')::uuid
 JOIN archive_payloads p ON p.hash=o.payload_hash;
