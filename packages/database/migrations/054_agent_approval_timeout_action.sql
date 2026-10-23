ALTER TABLE agent_execution_policy
  ADD COLUMN timeout_action text NOT NULL DEFAULT 'DENY'
  CHECK (timeout_action IN ('ALLOW', 'DENY'));
