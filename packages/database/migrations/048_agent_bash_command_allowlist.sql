ALTER TABLE agent_tool_allowlist DROP CONSTRAINT agent_tool_allowlist_kind_check;
ALTER TABLE agent_tool_allowlist ADD CONSTRAINT agent_tool_allowlist_kind_check
  CHECK (kind IN ('tool', 'bash_command'));
ALTER TABLE agent_tool_allowlist ADD CONSTRAINT agent_tool_allowlist_value_length_check
  CHECK ((kind = 'tool' AND length(value) BETWEEN 1 AND 136) OR (kind = 'bash_command' AND length(value) BETWEEN 1 AND 2000));

ALTER TABLE agent_permission_audit DROP CONSTRAINT agent_permission_audit_audit_kind_check;
ALTER TABLE agent_permission_audit ADD CONSTRAINT agent_permission_audit_audit_kind_check
  CHECK (audit_kind IN ('PERMISSION', 'EXECUTION_POLICY', 'ALLOWLIST', 'EXECUTION_APPROVAL'));
