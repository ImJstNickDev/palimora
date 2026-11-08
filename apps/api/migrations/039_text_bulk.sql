-- A revision orders publications; generation remains the content identity.
CREATE SEQUENCE catalog_text_revision AS bigint START 1000000000000;
ALTER TABLE catalog_text_pending
 ADD COLUMN revision bigint NOT NULL DEFAULT nextval('catalog_text_revision'),
 ADD COLUMN claim uuid,
 ADD COLUMN lease_until timestamptz,
 ADD COLUMN attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN error text,
 ADD COLUMN requested_generation text;
CREATE FUNCTION catalog_text_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.revision := nextval('catalog_text_revision');
 NEW.requested_generation := NULL;
 NEW.claim := NULL;
 NEW.lease_until := NULL;
 NEW.attempts := 0;
 NEW.retry_at := now();
 NEW.error := NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_text_invalidated BEFORE UPDATE OF work_id ON catalog_text_pending
 FOR EACH ROW EXECUTE FUNCTION catalog_text_invalidated();
CREATE INDEX catalog_text_ready ON catalog_text_pending(retry_at, work_id);
