ALTER TABLE agent_execution_policy ALTER COLUMN level SET DEFAULT 'full';

WITH changed AS (
  UPDATE agent_execution_policy
  SET level = 'full', version = version + 1, updated_at = clock_timestamp()
  WHERE singleton = true AND version = 1
  RETURNING version, approval_timeout_seconds
)
INSERT INTO agent_permission_audit
  (account_id, subject_kind, permission, old_effect, new_effect, new_version, actor, audit_kind, detail)
SELECT '*', 'EVERYONE', 'execution_policy', NULL, NULL, version, 'system:default_full', 'EXECUTION_POLICY',
  jsonb_build_object('level', 'full', 'approvalTimeoutSeconds', approval_timeout_seconds)
FROM changed;
