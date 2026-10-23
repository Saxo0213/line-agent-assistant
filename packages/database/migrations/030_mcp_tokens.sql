CREATE TABLE mcp_agent_tokens (
  token_id uuid PRIMARY KEY,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  principal_id text NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 1 AND 128),
  device_label text NOT NULL CHECK (length(btrim(device_label)) BETWEEN 1 AND 120),
  account_scopes text[] NOT NULL CHECK (cardinality(account_scopes) >= 1),
  tool_scopes text[] NOT NULL CHECK (
    cardinality(tool_scopes) >= 1
    AND tool_scopes <@ ARRAY['list_targets', 'query_target_messages', 'query_target_messages_by_time']::text[]
  ),
  grant_version bigint NOT NULL DEFAULT 1 CHECK (grant_version > 0),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'REVOKED')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'ACTIVE' AND revoked_at IS NULL) OR (state = 'REVOKED' AND revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at)
);

CREATE INDEX mcp_agent_tokens_state_expires_idx ON mcp_agent_tokens (state, expires_at);

CREATE TABLE mcp_agent_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id uuid REFERENCES mcp_agent_tokens(token_id) ON DELETE SET NULL,
  principal_id text NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 1 AND 128),
  initiator text NOT NULL CHECK (initiator IN ('user', 'external_agent', 'internal_agent')),
  action text NOT NULL CHECK (action IN ('TOKEN_ISSUED', 'TOKEN_REVOKED', 'TOOL_CALLED', 'AUTH_REJECTED')),
  tool_name text CHECK (tool_name IS NULL OR tool_name IN ('list_targets', 'query_target_messages', 'query_target_messages_by_time')),
  account_scopes text[] NOT NULL DEFAULT '{}'::text[],
  grant_version bigint CHECK (grant_version IS NULL OR grant_version > 0),
  disposition text NOT NULL CHECK (
    disposition IN ('ISSUED', 'REVOKED_BY_OPERATOR', 'ALLOWED', 'AUTH_INVALID', 'REVOKED', 'EXPIRED', 'SCOPE_DENIED', 'RATE_LIMITED', 'INVALID_INPUT')
  ),
  result_count integer CHECK (result_count IS NULL OR result_count >= 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX mcp_agent_audit_occurred_idx ON mcp_agent_audit (occurred_at DESC, audit_id DESC);
CREATE INDEX mcp_agent_audit_token_idx ON mcp_agent_audit (token_id, occurred_at DESC);

CREATE FUNCTION reject_mcp_agent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mcp_agent_audit is append-only';
END;
$$;

CREATE TRIGGER mcp_agent_audit_append_only
BEFORE UPDATE OR DELETE ON mcp_agent_audit
FOR EACH ROW EXECUTE FUNCTION reject_mcp_agent_audit_mutation();

CREATE TRIGGER mcp_agent_audit_no_truncate
BEFORE TRUNCATE ON mcp_agent_audit
FOR EACH STATEMENT EXECUTE FUNCTION reject_mcp_agent_audit_mutation();
