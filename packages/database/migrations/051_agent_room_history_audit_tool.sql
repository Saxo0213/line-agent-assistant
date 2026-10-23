-- Audit rows may name the internal-only Agent room history tool. Token tool_scopes keeps its original allowlist,
-- so an external token can never be issued (or stored) with this tool.
ALTER TABLE mcp_agent_audit DROP CONSTRAINT mcp_agent_audit_tool_name_check;
ALTER TABLE mcp_agent_audit ADD CONSTRAINT mcp_agent_audit_tool_name_check CHECK (
  tool_name IS NULL OR tool_name IN ('list_targets', 'query_target_messages', 'query_target_messages_by_time', 'query_agent_room_history')
);
