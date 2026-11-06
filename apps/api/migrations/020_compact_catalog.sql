-- This physical format is installed only on an empty archive. Identity, sessions,
-- inventory and audit are outside its scope. Populated catalogs are never erased.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM archive_work_heads) OR EXISTS(SELECT 1 FROM archive_objects)
 OR EXISTS(SELECT 1 FROM archive_record_data) OR EXISTS(SELECT 1 FROM archive_cache_data)
 OR EXISTS(SELECT 1 FROM archive_observation_data) OR EXISTS(SELECT 1 FROM archive_snapshots)
 OR EXISTS(SELECT 1 FROM ingest_results) OR EXISTS(SELECT 1 FROM archive_payloads WHERE value<>'{}'::jsonb)
 THEN RAISE EXCEPTION 'COMPACT_CATALOG_REQUIRES_EMPTY_ARCHIVE'; END IF;
END $$;
DROP VIEW archive_field_evidence,archive_evidence_observations,archive_field_selection;
DROP VIEW archive_works,archive_observations,archive_records,archive_parse_cache;
DROP TABLE archive_evidence_refs,archive_selection_docs,archive_observation_data,archive_cache_data,archive_record_data,ingest_results;
DROP FUNCTION archive_intern_payload(jsonb);
ALTER TABLE archive_work_heads DROP COLUMN metadata_hash;
DROP TABLE archive_payloads;
DROP FUNCTION archive_payload_hash(jsonb);
DROP TABLE archive_metadata_revisions CASCADE;
DROP TABLE archive_objects CASCADE;

CREATE TABLE archive_paths(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,path text NOT NULL UNIQUE);
CREATE TABLE archive_entries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,path_id bigint NOT NULL REFERENCES archive_paths,locator text NOT NULL,UNIQUE(path_id,locator));
CREATE TABLE archive_origins(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,path_id bigint NOT NULL REFERENCES archive_paths,fingerprint text NOT NULL,UNIQUE(path_id,fingerprint));
CREATE TABLE archive_parsers(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL UNIQUE);
CREATE TABLE archive_fields(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL UNIQUE);
CREATE TABLE archive_reasons(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL UNIQUE);
CREATE TABLE archive_packs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL UNIQUE);
CREATE TABLE archive_kinds(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL UNIQUE);
CREATE TABLE archive_object_data(
 hash bytea PRIMARY KEY CHECK(octet_length(hash)=32),pack_id bigint NOT NULL REFERENCES archive_packs,
 byte_offset bigint NOT NULL,length bigint NOT NULL,size bigint NOT NULL,kind_id integer NOT NULL REFERENCES archive_kinds
);
CREATE INDEX archive_object_pack ON archive_object_data(pack_id);
CREATE VIEW archive_objects AS SELECT encode(o.hash,'hex') AS hash,p.name AS pack,o.byte_offset,o.length,o.size,k.name AS kind
 FROM archive_object_data o JOIN archive_packs p ON p.id=o.pack_id JOIN archive_kinds k ON k.id=o.kind_id;
CREATE TABLE archive_metadata_data(hash bytea PRIMARY KEY REFERENCES archive_object_data DEFERRABLE INITIALLY DEFERRED);
CREATE TRIGGER metadata_revision_immutable BEFORE UPDATE OR DELETE ON archive_metadata_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE VIEW archive_metadata_revisions AS SELECT encode(hash,'hex') AS hash FROM archive_metadata_data;
ALTER TABLE archive_chapter_revisions RENAME TO archive_revision_data;
ALTER TABLE archive_revision_data ALTER COLUMN object_hash TYPE bytea USING decode(object_hash,'hex');
ALTER TABLE archive_revision_data ADD FOREIGN KEY(object_hash) REFERENCES archive_object_data DEFERRABLE INITIALLY DEFERRED;
CREATE VIEW archive_chapter_revisions AS SELECT id,chapter_id,encode(object_hash,'hex') AS object_hash FROM archive_revision_data;
ALTER TABLE archive_snapshots RENAME TO archive_snapshot_data;
ALTER TABLE archive_snapshot_data ALTER COLUMN manifest_hash TYPE bytea USING decode(manifest_hash,'hex');
ALTER TABLE archive_snapshot_data ALTER COLUMN metadata_hash TYPE bytea USING decode(metadata_hash,'hex');
ALTER TABLE archive_snapshot_data ADD FOREIGN KEY(manifest_hash) REFERENCES archive_object_data DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE archive_snapshot_data ADD FOREIGN KEY(metadata_hash) REFERENCES archive_metadata_data;
CREATE VIEW archive_snapshots AS SELECT id,work_id,encode(manifest_hash,'hex') AS manifest_hash,state,observed_at,imported_at,ordering_uncertain,encode(metadata_hash,'hex') AS metadata_hash FROM archive_snapshot_data;

CREATE TABLE archive_dictionaries(
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,family text NOT NULL UNIQUE,
 hash bytea NOT NULL UNIQUE CHECK(octet_length(hash)=32),data bytea NOT NULL CHECK(hash=sha256(data))
);
ALTER TABLE archive_dictionaries ALTER COLUMN data SET STORAGE EXTERNAL;
CREATE TRIGGER dictionary_immutable BEFORE UPDATE OR DELETE ON archive_dictionaries FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE TABLE archive_payloads(
 hash bytea PRIMARY KEY CHECK(octet_length(hash)=32),codec smallint NOT NULL CHECK(codec IN(0,1)),
 dictionary_id integer REFERENCES archive_dictionaries,raw_size integer NOT NULL CHECK(raw_size>=0),data bytea NOT NULL,
 CHECK(codec=1 OR (dictionary_id IS NULL AND raw_size=octet_length(data) AND hash=sha256(data)))
);
ALTER TABLE archive_payloads ALTER COLUMN data SET STORAGE EXTERNAL;
CREATE TRIGGER payload_immutable BEFORE UPDATE OR DELETE ON archive_payloads FOR EACH ROW EXECUTE FUNCTION archive_immutable();
INSERT INTO archive_payloads VALUES(sha256(convert_to('{}','UTF8')),0,NULL,2,convert_to('{}','UTF8'));
ALTER TABLE archive_work_heads DROP COLUMN provisional_key;
ALTER TABLE archive_work_heads ADD COLUMN provisional_entry_id bigint UNIQUE REFERENCES archive_entries;
ALTER TABLE archive_work_heads ADD COLUMN metadata_hash bytea NOT NULL DEFAULT sha256(convert_to('{}','UTF8')) REFERENCES archive_payloads;
-- The title is an exact JSON text projection, preserving existing ILIKE semantics.
ALTER TABLE archive_work_heads ADD COLUMN title text;
CREATE VIEW archive_works AS SELECT w.id,w.external_id,p.path||':'||e.locator AS provisional_key,w.metadata_hash,w.title,w.current_snapshot_id,w.head_reason
 FROM archive_work_heads w LEFT JOIN archive_entries e ON e.id=w.provisional_entry_id LEFT JOIN archive_paths p ON p.id=e.path_id;

CREATE TABLE archive_observation_data(
 id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES archive_work_heads,entry_id bigint NOT NULL REFERENCES archive_entries,
 parser_id integer NOT NULL REFERENCES archive_parsers,result_hash bytea NOT NULL CHECK(octet_length(result_hash)=32),payload_hash bytea NOT NULL REFERENCES archive_payloads,
 field_ids integer[] NOT NULL,evidence_ids bigint[] NOT NULL,CHECK(cardinality(field_ids)=cardinality(evidence_ids)),
 UNIQUE(work_id,entry_id,parser_id,result_hash)
);
CREATE TRIGGER observation_immutable BEFORE UPDATE OR DELETE ON archive_observation_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE VIEW archive_observations AS SELECT o.id,o.work_id,p.path AS source_path,e.locator,r.name AS parser,encode(o.result_hash,'hex') AS fingerprint,o.payload_hash,o.field_ids,o.evidence_ids
 FROM archive_observation_data o JOIN archive_entries e ON e.id=o.entry_id JOIN archive_paths p ON p.id=e.path_id JOIN archive_parsers r ON r.id=o.parser_id;
CREATE VIEW archive_evidence_observations AS SELECT a.evidence_id AS id,o.work_id,f.name AS field,o.payload_hash,p.path AS source_path,e.locator,r.name AS parser,encode(o.result_hash,'hex') AS fingerprint
 FROM archive_observation_data o JOIN archive_entries e ON e.id=o.entry_id JOIN archive_paths p ON p.id=e.path_id JOIN archive_parsers r ON r.id=o.parser_id
 CROSS JOIN LATERAL unnest(o.field_ids,o.evidence_ids) a(field_id,evidence_id) JOIN archive_fields f ON f.id=a.field_id;
CREATE FUNCTION archive_confidence(code smallint) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$SELECT CASE code WHEN 1 THEN 'index' WHEN 2 THEN 'document' WHEN 3 THEN 'admin' END$$;
CREATE FUNCTION archive_confidence_code(name text) RETURNS smallint LANGUAGE sql IMMUTABLE STRICT AS $$SELECT CASE name WHEN 'index' THEN 1 WHEN 'document' THEN 2 WHEN 'admin' THEN 3 END::smallint$$;
CREATE TABLE archive_evidence_data(
 work_id uuid NOT NULL REFERENCES archive_work_heads,entry_id bigint NOT NULL REFERENCES archive_entries,
 field_ids integer[] NOT NULL,observation_ids uuid[] NOT NULL,confidences smallint[] NOT NULL,
 PRIMARY KEY(work_id,entry_id),CHECK(cardinality(field_ids)=cardinality(observation_ids) AND cardinality(field_ids)=cardinality(confidences))
);
CREATE VIEW archive_evidence_refs AS SELECT r.work_id,p.path AS source_path,e.locator,
 coalesce((SELECT jsonb_object_agg(f.name,jsonb_build_object('observation',a.observation,'confidence',archive_confidence(a.confidence))) FROM unnest(r.field_ids,r.observation_ids,r.confidences) a(field_id,observation,confidence) JOIN archive_fields f ON f.id=a.field_id),'{}') AS fields
 FROM archive_evidence_data r JOIN archive_entries e ON e.id=r.entry_id JOIN archive_paths p ON p.id=e.path_id;
CREATE TYPE archive_evidence_vector AS (field_ids integer[],observation_ids uuid[],confidences smallint[]);
CREATE FUNCTION archive_merge_evidence(old_fields integer[],old_observations uuid[],old_confidences smallint[],new_fields integer[],new_observations uuid[],new_confidences smallint[])
 RETURNS archive_evidence_vector LANGUAGE plpgsql IMMUTABLE AS $$DECLARE i integer; BEGIN
 FOR i IN 1..coalesce(cardinality(new_fields),0) LOOP
 IF array_position(old_fields,new_fields[i]) IS NULL THEN
 old_fields:=array_append(old_fields,new_fields[i]);old_observations:=array_append(old_observations,new_observations[i]);old_confidences:=array_append(old_confidences,new_confidences[i]);
 END IF; END LOOP; RETURN (old_fields,old_observations,old_confidences); END$$;
CREATE TABLE archive_selection_data(
 work_id uuid PRIMARY KEY REFERENCES archive_work_heads,field_ids integer[] NOT NULL,entry_ids bigint[] NOT NULL,confidences smallint[] NOT NULL,reason_ids integer[] NOT NULL,
 CHECK(cardinality(field_ids)=cardinality(entry_ids) AND cardinality(field_ids)=cardinality(confidences) AND cardinality(field_ids)=cardinality(reason_ids))
);
CREATE VIEW archive_selection_docs AS SELECT s.work_id,coalesce((SELECT jsonb_object_agg(f.name,jsonb_build_object('confidence',archive_confidence(a.confidence),'source_path',p.path,'locator',e.locator,'reason',r.name))
 FROM unnest(s.field_ids,s.entry_ids,s.confidences,s.reason_ids) a(field_id,entry_id,confidence,reason_id) JOIN archive_fields f ON f.id=a.field_id JOIN archive_entries e ON e.id=a.entry_id JOIN archive_paths p ON p.id=e.path_id JOIN archive_reasons r ON r.id=a.reason_id),'{}') AS fields FROM archive_selection_data s;
CREATE VIEW archive_field_selection AS SELECT s.work_id,f.key AS field,f.value->>'confidence' AS confidence,f.value->>'source_path' AS source_path,f.value->>'locator' AS locator,f.value->>'reason' AS reason FROM archive_selection_docs s CROSS JOIN LATERAL jsonb_each(s.fields) f;

CREATE TABLE archive_record_data(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,entry_id bigint NOT NULL REFERENCES archive_entries,origin_id bigint NOT NULL REFERENCES archive_origins,
 parser_id integer NOT NULL REFERENCES archive_parsers,result_hash bytea NOT NULL CHECK(octet_length(result_hash)=32),work_id uuid NOT NULL REFERENCES archive_work_heads,
 snapshot_id uuid REFERENCES archive_snapshot_data,raw_metadata_hash bytea REFERENCES archive_payloads,
 source_hash bytea CHECK(source_hash IS NULL OR octet_length(source_hash)=32),observed_at text,observed_present boolean NOT NULL,
 UNIQUE(origin_id,entry_id,parser_id,result_hash)
);
CREATE INDEX archive_records_work ON archive_record_data(work_id);
CREATE INDEX archive_record_snapshot ON archive_record_data(snapshot_id);
CREATE TRIGGER record_immutable BEFORE UPDATE OR DELETE ON archive_record_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE VIEW archive_records AS SELECT r.id,p.path AS source_path,o.fingerprint,e.locator,parser.name AS parser,encode(r.result_hash,'hex') AS result_hash,r.work_id,r.snapshot_id,r.raw_metadata_hash,
 jsonb_build_object('source_hash',encode(r.source_hash,'hex'))||CASE WHEN r.observed_present THEN jsonb_build_object('observed_at',r.observed_at) ELSE '{}'::jsonb END AS evidence
 FROM archive_record_data r JOIN archive_entries e ON e.id=r.entry_id JOIN archive_paths p ON p.id=e.path_id JOIN archive_origins o ON o.id=r.origin_id JOIN archive_parsers parser ON parser.id=r.parser_id;
CREATE TABLE ingest_result_data(source_id uuid NOT NULL REFERENCES ingest_sources,record_id bigint NOT NULL REFERENCES archive_record_data,PRIMARY KEY(source_id,record_id));
CREATE TRIGGER ingest_result_immutable BEFORE UPDATE OR DELETE ON ingest_result_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
CREATE VIEW ingest_results AS SELECT s.source_id,r.fingerprint,r.locator,r.parser,r.result_hash,r.work_id,r.snapshot_id FROM ingest_result_data s JOIN archive_records r ON r.id=s.record_id;
CREATE TABLE archive_cache_data(
 source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),parser_id integer NOT NULL REFERENCES archive_parsers,
 raw_metadata_hash bytea REFERENCES archive_payloads,body_hash bytea NOT NULL CHECK(octet_length(body_hash)=32),codec smallint NOT NULL CHECK(codec IN(0,1)),dictionary_id integer REFERENCES archive_dictionaries,
 raw_size integer NOT NULL CHECK(raw_size>=0),data bytea NOT NULL,PRIMARY KEY(source_hash,parser_id),
 CHECK(codec=1 OR (dictionary_id IS NULL AND raw_size=octet_length(data) AND body_hash=sha256(data)))
);
ALTER TABLE archive_cache_data ALTER COLUMN data SET STORAGE EXTERNAL;
CREATE TRIGGER parse_cache_immutable BEFORE UPDATE OR DELETE ON archive_cache_data FOR EACH ROW EXECUTE FUNCTION archive_immutable();
-- Arrays refer to dictionary rows. Their identifiers/names are permanent; reset
-- truncates the complete archive scope atomically instead of deleting entries.
DO $$ DECLARE name text; BEGIN FOREACH name IN ARRAY ARRAY['archive_paths','archive_entries','archive_origins','archive_parsers','archive_fields','archive_reasons','archive_packs','archive_kinds'] LOOP
 EXECUTE format('CREATE TRIGGER dictionary_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION archive_immutable()',name);
END LOOP; END$$;
