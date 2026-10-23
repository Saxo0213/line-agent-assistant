-- Audit rows may name the internal-only Agent LINE send tools. Token tool_scopes keeps its original allowlist,
-- so an external token can never be issued (or stored) with these tools.
ALTER TABLE mcp_agent_audit DROP CONSTRAINT mcp_agent_audit_tool_name_check;
ALTER TABLE mcp_agent_audit ADD CONSTRAINT mcp_agent_audit_tool_name_check CHECK (
  tool_name IS NULL OR tool_name IN (
    'list_targets', 'query_target_messages', 'query_target_messages_by_time', 'query_agent_room_history',
    'list_send_targets', 'send_to_target'
  )
);

-- One append-only row per item the Agent sent (or tried to send) to LINE. It stores no message text and no file name.
CREATE TABLE agent_line_sends (
  send_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  account_id text NOT NULL,
  principal_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  item_index integer NOT NULL CHECK (item_index >= 0),
  item_kind text NOT NULL CHECK (item_kind IN ('text', 'message', 'attachment', 'file')),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'unknown', 'denied')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX agent_line_sends_job_idx ON agent_line_sends (job_id);

CREATE FUNCTION reject_agent_line_sends_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_line_sends is append-only';
END;
$$;

CREATE TRIGGER agent_line_sends_append_only
BEFORE UPDATE OR DELETE ON agent_line_sends
FOR EACH ROW EXECUTE FUNCTION reject_agent_line_sends_mutation();

CREATE TRIGGER agent_line_sends_no_truncate
BEFORE TRUNCATE ON agent_line_sends
FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_line_sends_mutation();
