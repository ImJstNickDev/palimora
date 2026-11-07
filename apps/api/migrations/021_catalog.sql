CREATE TABLE catalog_documents (
 work_id uuid PRIMARY KEY REFERENCES archive_work_heads(id), snapshot_id uuid,
 metadata jsonb NOT NULL, title text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_metadata ON catalog_documents USING gin(metadata);
CREATE INDEX catalog_title ON catalog_documents(title,work_id);
CREATE TABLE catalog_pending(work_id uuid PRIMARY KEY REFERENCES archive_work_heads(id));
CREATE FUNCTION catalog_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO catalog_pending VALUES(NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER catalog_changed AFTER INSERT OR UPDATE ON archive_work_heads FOR EACH ROW EXECUTE FUNCTION catalog_changed();
INSERT INTO catalog_pending SELECT id FROM archive_work_heads;
CREATE TABLE catalog_text_pending(work_id uuid PRIMARY KEY REFERENCES archive_work_heads(id));
CREATE INDEX catalog_search ON catalog_documents USING gin(to_tsvector('simple',metadata::text));
