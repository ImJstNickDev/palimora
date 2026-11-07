CREATE TABLE library_collections (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=4000), revision integer NOT NULL DEFAULT 1,
 deleted boolean NOT NULL DEFAULT false
);
CREATE FUNCTION library_owner_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.owner_id<>OLD.owner_id THEN RAISE EXCEPTION 'collection owner immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER collection_owner BEFORE UPDATE ON library_collections FOR EACH ROW EXECUTE FUNCTION library_owner_immutable();
CREATE TABLE library_members (
 collection_id uuid REFERENCES library_collections, user_id uuid REFERENCES users,
 role text NOT NULL CHECK(role IN ('Editor','Viewer')), accepted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(collection_id,user_id)
);
CREATE TABLE library_collection_works (
 collection_id uuid REFERENCES library_collections, work_id uuid REFERENCES archive_work_heads,
 PRIMARY KEY(collection_id,work_id)
);
CREATE INDEX library_member_user ON library_members(user_id,collection_id);
CREATE FUNCTION library_collection_write_acl() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid := nullif(current_setting('palimora.user',true),'')::uuid; cid uuid; owner uuid; allowed boolean;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'collection actor required' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='library_collections' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.owner_id<>actor THEN RAISE EXCEPTION 'collection owner required' USING ERRCODE='42501'; END IF;
   RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'physical collection deletion forbidden'; END IF;
  cid:=OLD.id; owner:=OLD.owner_id;
  IF NEW.deleted<>OLD.deleted AND actor<>owner THEN RAISE EXCEPTION 'collection owner required' USING ERRCODE='42501'; END IF;
 ELSE
  IF TG_OP='DELETE' THEN cid:=OLD.collection_id; ELSE cid:=NEW.collection_id; END IF;
  SELECT owner_id INTO owner FROM library_collections WHERE id=cid AND NOT deleted FOR UPDATE;
 END IF;
 IF TG_TABLE_NAME='library_members' THEN
  IF TG_OP='UPDATE' AND actor=OLD.user_id AND NEW.role=OLD.role AND NEW.collection_id=OLD.collection_id AND NEW.user_id=OLD.user_id THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND actor=OLD.user_id THEN RETURN OLD; END IF;
  IF actor IS DISTINCT FROM owner THEN RAISE EXCEPTION 'collection owner required' USING ERRCODE='42501'; END IF;
  IF TG_OP<>'DELETE' AND NEW.user_id=owner THEN RAISE EXCEPTION 'owner is not a member'; END IF;
 ELSE
  allowed := actor=owner OR EXISTS(SELECT 1 FROM library_members WHERE collection_id=cid AND user_id=actor AND accepted AND role='Editor');
  IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'collection write denied' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER collection_write_acl BEFORE INSERT OR UPDATE OR DELETE ON library_collections FOR EACH ROW EXECUTE FUNCTION library_collection_write_acl();
CREATE TRIGGER member_write_acl BEFORE INSERT OR UPDATE OR DELETE ON library_members FOR EACH ROW EXECUTE FUNCTION library_collection_write_acl();
CREATE TRIGGER collection_item_write_acl BEFORE INSERT OR UPDATE OR DELETE ON library_collection_works FOR EACH ROW EXECUTE FUNCTION library_collection_write_acl();
