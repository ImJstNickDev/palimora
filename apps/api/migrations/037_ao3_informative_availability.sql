-- An absent job and an unknown job both leave canonical availability unchanged.
-- Keep real transitions (including known -> unknown) and informative inserts.
CREATE OR REPLACE FUNCTION ao3_availability_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='work' AND
   ((TG_OP='INSERT' AND NEW.availability <> 'unknown') OR
    (TG_OP='UPDATE' AND OLD.availability IS DISTINCT FROM NEW.availability)) THEN
  INSERT INTO catalog_pending SELECT id FROM archive_work_heads WHERE external_id=NEW.target ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
