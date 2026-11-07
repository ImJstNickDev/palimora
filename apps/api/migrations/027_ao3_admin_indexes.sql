CREATE INDEX ao3_media_unrecoverable ON ao3_jobs(id) WHERE kind='media' AND error='MEDIA_UNRECOVERABLE';
CREATE INDEX archive_media_url ON archive_media_references(url,work_id);
