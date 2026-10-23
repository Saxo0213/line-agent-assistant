CREATE TABLE account_administrator_versions (
  account_id text PRIMARY KEY REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO account_administrator_versions (account_id, version)
SELECT account_id, 1 FROM account_administrators GROUP BY account_id;

CREATE FUNCTION bump_account_administrator_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE account_administrator_versions SET version = version + 1, updated_at = clock_timestamp()
      WHERE account_id = OLD.account_id;
    RETURN OLD;
  END IF;
  INSERT INTO account_administrator_versions (account_id, version)
  VALUES (NEW.account_id, 1)
  ON CONFLICT (account_id) DO UPDATE
    SET version = account_administrator_versions.version + 1, updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_administrator_version_trigger
AFTER INSERT OR UPDATE OR DELETE ON account_administrators
FOR EACH ROW EXECUTE FUNCTION bump_account_administrator_version();

CREATE TABLE room_agent_policies (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('group', 'room')),
  chat_id text NOT NULL,
  state text NOT NULL DEFAULT 'DISABLED' CHECK (state IN ('DISABLED', 'PENDING_CONFIRMATION', 'ENABLED')),
  authority_version bigint NOT NULL DEFAULT 1 CHECK (authority_version > 0),
  confirmed_request_id uuid,
  authorizing_admin_user_id text,
  authorizing_admin_version bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, chat_type, chat_id),
  FOREIGN KEY (account_id, chat_type, chat_id) REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE
);

CREATE TABLE room_activation_requests (
  request_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('group', 'room')),
  chat_id text NOT NULL,
  source_message_id text NOT NULL,
  requester_id text NOT NULL,
  admin_chat_id text NOT NULL,
  admin_user_id text NOT NULL,
  admin_version bigint NOT NULL CHECK (admin_version > 0),
  room_authority_version bigint NOT NULL CHECK (room_authority_version > 0),
  state text NOT NULL CHECK (state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN', 'CONSUMED', 'EXPIRED', 'CANCELLED', 'EXHAUSTED')),
  request_version bigint NOT NULL DEFAULT 1 CHECK (request_version > 0),
  wait_expires_at timestamptz NOT NULL,
  confirm_expires_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, chat_type, chat_id, source_message_id),
  FOREIGN KEY (account_id, chat_type, chat_id) REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX room_activation_one_active_request_idx
  ON room_activation_requests (account_id, chat_type, chat_id)
  WHERE state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN');
CREATE INDEX room_activation_pending_capacity_idx ON room_activation_requests (account_id, created_at)
  WHERE state IN ('WAITING_TO_SEND', 'PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN');
CREATE INDEX room_activation_wait_lease_idx ON room_activation_requests (lease_expires_at)
  WHERE state = 'WAITING_TO_SEND';
CREATE INDEX room_activation_wait_expiry_idx ON room_activation_requests (wait_expires_at)
  WHERE state = 'WAITING_TO_SEND';
CREATE INDEX room_activation_confirm_expiry_idx ON room_activation_requests (confirm_expires_at)
  WHERE state IN ('PENDING_CONFIRMATION', 'DELIVERY_UNKNOWN');

CREATE TABLE room_activation_challenges (
  request_id uuid PRIMARY KEY REFERENCES room_activation_requests(request_id) ON DELETE CASCADE,
  token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
  digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
  send_state text NOT NULL CHECK (send_state IN ('MAY_HAVE_STARTED', 'UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz
);
CREATE INDEX room_activation_challenge_expiry_idx ON room_activation_challenges (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE room_activation_confirmation_attempts (
  request_id uuid NOT NULL REFERENCES room_activation_requests(request_id) ON DELETE CASCADE,
  source_message_id text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('WRONG_TOKEN', 'ENABLED', 'EXPIRED', 'CANCELLED', 'EXHAUSTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, source_message_id)
);

CREATE TABLE room_agent_grants (
  grant_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('group', 'room')),
  chat_id text NOT NULL,
  capability text NOT NULL CHECK (capability = 'AGENT_USE_ROOM'),
  version bigint NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
  request_id uuid NOT NULL REFERENCES room_activation_requests(request_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  FOREIGN KEY (account_id, chat_type, chat_id) REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX room_agent_one_active_grant_idx ON room_agent_grants (account_id, chat_type, chat_id, capability) WHERE state = 'ACTIVE';

CREATE TABLE room_activation_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('group', 'room')),
  chat_id text NOT NULL,
  request_id uuid,
  event text NOT NULL CHECK (event IN ('REQUESTED', 'CHALLENGE_MAY_HAVE_STARTED', 'CONFIRMED', 'CANCELLED', 'REVOKED', 'EXPIRED', 'EXHAUSTED', 'ADMIN_CHANGED')),
  actor_id text,
  authority_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION reject_room_activation_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'room_activation_audit is append-only';
END;
$$;
CREATE TRIGGER room_activation_audit_append_only
BEFORE UPDATE OR DELETE ON room_activation_audit
FOR EACH ROW EXECUTE FUNCTION reject_room_activation_audit_mutation();
