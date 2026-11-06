CREATE TABLE archive_tag_observations(source_path text NOT NULL,fingerprint text NOT NULL,source_id text NOT NULL,evidence jsonb NOT NULL,PRIMARY KEY(source_path,fingerprint,source_id));
CREATE TRIGGER tag_observation_immutable BEFORE UPDATE OR DELETE ON archive_tag_observations FOR EACH ROW EXECUTE FUNCTION archive_immutable();
