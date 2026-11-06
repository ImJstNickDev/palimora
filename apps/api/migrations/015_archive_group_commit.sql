-- Object references are checked at commit, after the transaction has bulk-written
-- and sealed its bounded set of pack records. No committed reference may be missing.
ALTER TABLE archive_metadata_revisions ALTER CONSTRAINT archive_metadata_revisions_hash_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE archive_chapter_revisions ALTER CONSTRAINT archive_chapter_revisions_object_hash_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE archive_snapshots ALTER CONSTRAINT archive_snapshots_manifest_hash_fkey DEFERRABLE INITIALLY DEFERRED;
