ALTER TABLE catalog_documents ADD COLUMN generation text NOT NULL DEFAULT '', ADD COLUMN bibliography jsonb NOT NULL DEFAULT '{}';
CREATE TABLE catalog_tags(id text PRIMARY KEY, source_id text UNIQUE, name text NOT NULL, kind text NOT NULL, canonical boolean, UNIQUE(kind,name));
CREATE INDEX catalog_tag_names ON catalog_tags(lower(name),id);
CREATE TABLE catalog_tag_edges(child text NOT NULL REFERENCES catalog_tags, parent text NOT NULL REFERENCES catalog_tags, kind text NOT NULL CHECK(kind IN('synonym','meta','parent')), PRIMARY KEY(child,parent,kind));
CREATE TABLE catalog_entities(id text PRIMARY KEY, kind text NOT NULL, source_id text, name text NOT NULL, url text, details jsonb NOT NULL DEFAULT '{}', UNIQUE(kind,source_id));
CREATE INDEX catalog_entity_names ON catalog_entities(kind,lower(name),id);
CREATE TABLE catalog_entity_works(entity_id text NOT NULL REFERENCES catalog_entities, work_id uuid NOT NULL REFERENCES archive_work_heads, snapshot_id uuid, position numeric, PRIMARY KEY(entity_id,work_id));
CREATE INDEX catalog_entity_work ON catalog_entity_works(work_id);
CREATE TABLE catalog_work_tags(work_id uuid NOT NULL REFERENCES archive_work_heads,tag_id text NOT NULL REFERENCES catalog_tags,PRIMARY KEY(work_id,tag_id));
CREATE INDEX catalog_tag_work ON catalog_work_tags(tag_id,work_id);
CREATE TABLE catalog_graph_pending(id integer PRIMARY KEY CHECK(id=1));
INSERT INTO catalog_graph_pending VALUES(1);
CREATE FUNCTION catalog_tag_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO catalog_graph_pending VALUES(1) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER catalog_tag_changed AFTER INSERT OR UPDATE ON archive_tags FOR EACH STATEMENT EXECUTE FUNCTION catalog_tag_changed();
INSERT INTO catalog_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING;
CREATE TABLE catalog_search_state(id integer PRIMARY KEY CHECK(id=1), index_name text NOT NULL, epoch uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO catalog_search_state(id,index_name) VALUES(1,'palimora-works-v2');

CREATE TRIGGER catalog_edge_changed AFTER INSERT OR DELETE ON catalog_tag_edges FOR EACH ROW EXECUTE FUNCTION catalog_tag_changed();
CREATE TABLE catalog_snapshot_views(snapshot_id uuid PRIMARY KEY REFERENCES archive_snapshot_data,metadata jsonb NOT NULL,bibliography jsonb NOT NULL);
CREATE TABLE catalog_snapshot_pending(snapshot_id uuid PRIMARY KEY REFERENCES archive_snapshot_data);
CREATE FUNCTION catalog_snapshot_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO catalog_snapshot_pending VALUES(NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER catalog_snapshot_changed AFTER INSERT ON archive_snapshot_data FOR EACH ROW EXECUTE FUNCTION catalog_snapshot_changed();
INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshot_data;
