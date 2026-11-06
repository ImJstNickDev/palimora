-- Preserve every existing evidence ID while packing fields by acquisition.
ALTER SEQUENCE archive_evidence_observations_id_seq OWNED BY NONE;
CREATE TABLE archive_observations (
 id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES archive_works,
 source_path text NOT NULL, locator text NOT NULL, parser text NOT NULL,
 fingerprint text NOT NULL, fields jsonb NOT NULL,
 UNIQUE(work_id,source_path,locator,parser,fingerprint)
);
INSERT INTO archive_observations
 SELECT gen_random_uuid(),work_id,source_path,locator,parser,fingerprint,
 jsonb_object_agg(field,jsonb_build_object('id',id::text,'value',value))
 FROM archive_evidence_observations GROUP BY work_id,source_path,locator,parser,fingerprint;
-- Older catalogs may have field evidence predating the observation migration.
INSERT INTO archive_observations
 SELECT gen_random_uuid(),e.work_id,e.source_path,e.locator,'migration-017','legacy',
 jsonb_object_agg(e.field,jsonb_build_object('id',nextval('archive_evidence_observations_id_seq')::text,'value',e.value))
 FROM archive_field_evidence e WHERE NOT EXISTS(
 SELECT 1 FROM archive_observations o WHERE o.work_id=e.work_id AND o.source_path=e.source_path AND o.locator=e.locator AND o.fields->e.field->'value'=e.value)
 GROUP BY e.work_id,e.source_path,e.locator;
CREATE TABLE archive_evidence_refs (
 work_id uuid NOT NULL REFERENCES archive_works, source_path text NOT NULL,
 locator text NOT NULL, fields jsonb NOT NULL, PRIMARY KEY(work_id,source_path,locator)
);
INSERT INTO archive_evidence_refs
 SELECT e.work_id,e.source_path,e.locator,jsonb_object_agg(e.field,jsonb_build_object('observation',o.id,'confidence',e.confidence))
 FROM archive_field_evidence e CROSS JOIN LATERAL (
 SELECT id FROM archive_observations o WHERE o.work_id=e.work_id AND o.source_path=e.source_path AND o.locator=e.locator AND o.fields->e.field->'value'=e.value ORDER BY id LIMIT 1
 ) o GROUP BY e.work_id,e.source_path,e.locator;
CREATE TABLE archive_selection_docs (work_id uuid PRIMARY KEY REFERENCES archive_works, fields jsonb NOT NULL);
INSERT INTO archive_selection_docs
 SELECT work_id,jsonb_object_agg(field,jsonb_build_object('confidence',confidence,'source_path',source_path,'locator',locator,'reason',reason))
 FROM archive_field_selection GROUP BY work_id;
DO $$ BEGIN
 IF (SELECT count(*) FROM archive_evidence_observations)<>(SELECT count(*) FROM archive_observations o CROSS JOIN LATERAL jsonb_each(o.fields) f WHERE o.parser<>'migration-017') THEN RAISE EXCEPTION 'observation migration count mismatch'; END IF;
 IF (SELECT count(*) FROM archive_field_evidence)<>(SELECT count(*) FROM archive_evidence_refs r CROSS JOIN LATERAL jsonb_each(r.fields)) THEN RAISE EXCEPTION 'evidence migration count mismatch'; END IF;
END $$;
DROP TABLE archive_evidence_observations;
DROP TABLE archive_field_evidence;
DROP TABLE archive_field_selection;
CREATE VIEW archive_evidence_observations AS
 SELECT (f.value->>'id')::bigint AS id,o.work_id,f.key AS field,f.value->'value' AS value,o.source_path,o.locator,o.parser,o.fingerprint
 FROM archive_observations o CROSS JOIN LATERAL jsonb_each(o.fields) f;
CREATE VIEW archive_field_evidence AS
 SELECT r.work_id,f.key AS field,o.fields->f.key->'value' AS value,r.source_path,r.locator,f.value->>'confidence' AS confidence
 FROM archive_evidence_refs r CROSS JOIN LATERAL jsonb_each(r.fields) f
 JOIN archive_observations o ON o.id=(f.value->>'observation')::uuid;
CREATE VIEW archive_field_selection AS
 SELECT s.work_id,f.key AS field,f.value->>'confidence' AS confidence,f.value->>'source_path' AS source_path,f.value->>'locator' AS locator,f.value->>'reason' AS reason
 FROM archive_selection_docs s CROSS JOIN LATERAL jsonb_each(s.fields) f;
CREATE TRIGGER observation_immutable BEFORE UPDATE OR DELETE ON archive_observations FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TABLE archive_parse_cache (
 source_hash text NOT NULL, parser text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(source_hash,parser)
);
CREATE TRIGGER parse_cache_immutable BEFORE UPDATE OR DELETE ON archive_parse_cache FOR EACH ROW EXECUTE FUNCTION archive_immutable();

ALTER TABLE ingest_sources ADD COLUMN index_progress bigint;
