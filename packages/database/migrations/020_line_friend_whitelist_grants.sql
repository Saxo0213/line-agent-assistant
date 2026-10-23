CREATE TABLE line_friend_whitelist_grants (
  grant_id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  target_mid text NOT NULL CHECK (length(target_mid) > 0),
  capability text NOT NULL CHECK (capability = 'AGENT_USE_DIRECT'),
  version bigint NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK ((state = 'ACTIVE' AND revoked_at IS NULL) OR (state = 'REVOKED' AND revoked_at IS NOT NULL)),
  UNIQUE (account_id, target_mid, version)
);

CREATE UNIQUE INDEX line_friend_whitelist_one_active_idx
  ON line_friend_whitelist_grants (account_id, target_mid) WHERE state = 'ACTIVE';
CREATE INDEX line_friend_whitelist_active_lookup_idx
  ON line_friend_whitelist_grants (account_id, target_mid, version DESC) WHERE state = 'ACTIVE';

CREATE TABLE line_friend_whitelist_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id uuid NOT NULL,
  account_id text NOT NULL,
  target_mid text NOT NULL,
  action text NOT NULL CHECK (action IN ('ACTIVATED', 'REVOKED')),
  actor_id text,
  grant_version bigint NOT NULL CHECK (grant_version > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION reject_line_friend_whitelist_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'line_friend_whitelist_audit is append-only';
END;
$$;
CREATE TRIGGER line_friend_whitelist_audit_append_only
BEFORE UPDATE OR DELETE ON line_friend_whitelist_audit
FOR EACH ROW EXECUTE FUNCTION reject_line_friend_whitelist_audit_mutation();

ALTER TABLE agent_jobs
  ADD COLUMN direct_friend_grant_id uuid,
  ADD COLUMN direct_friend_grant_version bigint,
  ADD COLUMN room_agent_grant_id uuid,
  ADD COLUMN room_agent_grant_version bigint;
