CREATE FUNCTION catalog_identity_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'DELETE' THEN INSERT INTO catalog_pending VALUES(NEW.work_id),(NEW.canonical_work_id) ON CONFLICT DO NOTHING; END IF;
 IF TG_OP<>'INSERT' THEN INSERT INTO catalog_pending VALUES(OLD.work_id),(OLD.canonical_work_id) ON CONFLICT DO NOTHING; END IF;
 RETURN NULL; END $$;
CREATE TRIGGER catalog_identity_changed AFTER INSERT OR UPDATE OR DELETE ON archive_identity_links FOR EACH ROW EXECUTE FUNCTION catalog_identity_changed();
