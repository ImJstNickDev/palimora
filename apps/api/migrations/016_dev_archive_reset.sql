ALTER TABLE archive_jobs DROP CONSTRAINT archive_jobs_kind_check;
ALTER TABLE archive_jobs ADD CONSTRAINT archive_jobs_kind_check CHECK(kind IN ('compact','collect','reset_dev'));
