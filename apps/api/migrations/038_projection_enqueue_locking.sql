-- A no-op conflict can observe a pending row while its consumer is still
-- projecting old state. Updating the key waits for that consumer's row lock;
-- after its DELETE commits the new invalidation is inserted instead of lost.
CREATE OR REPLACE FUNCTION catalog_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO catalog_pending VALUES(NEW.id)
 ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION ao3_availability_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='work' AND
   ((TG_OP='INSERT' AND NEW.availability <> 'unknown') OR
    (TG_OP='UPDATE' AND OLD.availability IS DISTINCT FROM NEW.availability)) THEN
  INSERT INTO catalog_pending SELECT id FROM archive_work_heads WHERE external_id=NEW.target
  ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id;
 END IF;
 RETURN NULL;
END $$;
