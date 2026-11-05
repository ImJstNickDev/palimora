ALTER TABLE challenges DROP CONSTRAINT challenges_kind_check;
ALTER TABLE challenges ADD CONSTRAINT challenges_kind_check
  CHECK (kind IN ('totp', 'totp-ready', 'registration', 'authentication'));
