-- Keep existing account-wide rows as fallback while allowing per-chat USER overrides.
ALTER TABLE agent_permission_rules
  ADD COLUMN chat_type text CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'room')),
  ADD COLUMN chat_id text;
ALTER TABLE agent_permission_rules
  ADD CONSTRAINT agent_permission_rules_chat_scope_check CHECK (
    (chat_type IS NULL AND chat_id IS NULL)
    OR (chat_type IS NOT NULL AND chat_id IS NOT NULL AND chat_id <> '' AND subject_kind = 'USER')
  );
DROP INDEX agent_permission_rules_subject_idx;
CREATE UNIQUE INDEX agent_permission_rules_subject_idx
  ON agent_permission_rules (account_id, subject_kind, coalesce(subject_mid, ''), permission)
  WHERE chat_type IS NULL;
CREATE UNIQUE INDEX agent_permission_rules_chat_subject_idx
  ON agent_permission_rules (account_id, subject_mid, chat_type, chat_id, permission)
  WHERE chat_type IS NOT NULL;

ALTER TABLE agent_permission_audit
  ADD COLUMN chat_type text CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'room')),
  ADD COLUMN chat_id text;
ALTER TABLE agent_permission_audit
  ADD CONSTRAINT agent_permission_audit_chat_scope_check CHECK (
    (chat_type IS NULL AND chat_id IS NULL)
    OR (chat_type IS NOT NULL AND chat_id IS NOT NULL AND chat_id <> '' AND subject_kind = 'USER')
  );
CREATE INDEX agent_permission_audit_chat_subject_idx
  ON agent_permission_audit (account_id, subject_mid, chat_type, chat_id, permission, new_version DESC)
  WHERE chat_type IS NOT NULL;

-- Application-level defaults used only when no account-specific user/EVERYONE rule applies.
ALTER TABLE agent_permission_audit DROP CONSTRAINT agent_permission_audit_audit_kind_check;
ALTER TABLE agent_permission_audit ADD CONSTRAINT agent_permission_audit_audit_kind_check
  CHECK (audit_kind IN ('PERMISSION', 'EXECUTION_POLICY', 'ALLOWLIST', 'EXECUTION_APPROVAL', 'GLOBAL_PERMISSION_DEFAULT'));
CREATE TABLE agent_permission_global_defaults (
  permission text PRIMARY KEY CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(permission) <= 64),
  effect text NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text
);
