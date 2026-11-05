CREATE TABLE instance (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), state text NOT NULL CHECK(state IN ('uninitialized','initializing','active')) DEFAULT 'uninitialized',
 name text, initialized_at timestamptz,
 CHECK ((state='active') = (initialized_at IS NOT NULL))
);
INSERT INTO instance(id) VALUES(true);
CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL, email text, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('Owner','Admin','User')), disabled boolean NOT NULL DEFAULT false,
 soft_deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 preferences jsonb NOT NULL DEFAULT '{"language":"it","theme":"auto","skin":"ink"}',
 totp_secret text, totp_counter bigint NOT NULL DEFAULT -1
);
CREATE UNIQUE INDEX users_username ON users(lower(username));
CREATE UNIQUE INDEX one_owner ON users(role) WHERE role='Owner';
CREATE FUNCTION protect_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'physical deletion forbidden'; END IF;
 IF OLD.role='Owner' AND (NEW.role<>'Owner' OR NEW.disabled OR NEW.soft_deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'owner immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER users_protection BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION protect_owner();
CREATE TABLE sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, token_hash text UNIQUE NOT NULL, csrf text NOT NULL,
 device text NOT NULL, ip text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invites (
 id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, email text, expires_at timestamptz NOT NULL,
 max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 100), uses integer NOT NULL DEFAULT 0 CHECK(uses>=0 AND uses<=max_uses),
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES users,
 request_id uuid UNIQUE NOT NULL
);
CREATE TABLE recovery_codes (user_id uuid REFERENCES users, code_hash text NOT NULL, PRIMARY KEY(user_id,code_hash));
CREATE TABLE passkeys (id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, public_key bytea NOT NULL, counter bigint NOT NULL,
 transports jsonb NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX passkeys_user ON passkeys(user_id);
CREATE TABLE challenges (id text PRIMARY KEY, user_id uuid REFERENCES users, session_id uuid REFERENCES sessions,
 kind text NOT NULL CHECK(kind IN ('totp','registration','authentication')), value text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes');
CREATE INDEX challenges_expiry ON challenges(expires_at);
CREATE TABLE rate_limits (key text PRIMARY KEY, hits integer NOT NULL, until_at timestamptz NOT NULL);
CREATE TABLE audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users, effective_user_id uuid REFERENCES users,
 session_id uuid, ip text NOT NULL, action text NOT NULL, target text, details jsonb NOT NULL DEFAULT '{}',
 outcome text NOT NULL DEFAULT 'success', created_at timestamptz NOT NULL DEFAULT now(), request_id uuid NOT NULL
);
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit append only'; END $$;
CREATE TRIGGER audit_protection BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION audit_immutable();
