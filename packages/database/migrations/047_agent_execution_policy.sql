CREATE TABLE agent_execution_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  level text NOT NULL DEFAULT 'workspace_write' CHECK (level IN ('read_only', 'workspace_write', 'trust', 'full')),
  approval_timeout_seconds integer NOT NULL DEFAULT 180 CHECK (approval_timeout_seconds BETWEEN 10 AND 900),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agent_tool_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('tool')),
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, value)
);

ALTER TABLE agent_permission_audit ADD COLUMN audit_kind text NOT NULL DEFAULT 'PERMISSION'
  CHECK (audit_kind IN ('PERMISSION', 'EXECUTION_POLICY', 'ALLOWLIST'));
ALTER TABLE agent_permission_audit ADD COLUMN detail jsonb;
