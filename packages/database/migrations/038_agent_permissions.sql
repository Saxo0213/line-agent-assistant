-- Agent permission rules (extensible registry lives in code; this table stores overrides only).
-- "Use default" is represented by the absence of a row.
CREATE TABLE agent_permission_rules (
  rule_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('EVERYONE', 'USER')),
  subject_mid text CHECK (subject_mid IS NULL OR (subject_mid <> '' AND length(subject_mid) <= 512)),
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(permission) <= 64),
  effect text NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text,
  CHECK ((subject_kind = 'EVERYONE' AND subject_mid IS NULL) OR (subject_kind = 'USER' AND subject_mid IS NOT NULL))
);

CREATE UNIQUE INDEX agent_permission_rules_subject_idx
  ON agent_permission_rules (account_id, subject_kind, coalesce(subject_mid, ''), permission);

CREATE TABLE agent_permission_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('EVERYONE', 'USER')),
  subject_mid text,
  permission text NOT NULL,
  old_effect text CHECK (old_effect IS NULL OR old_effect IN ('ALLOW', 'DENY')),
  new_effect text CHECK (new_effect IS NULL OR new_effect IN ('ALLOW', 'DENY')),
  new_version bigint NOT NULL CHECK (new_version > 0),
  actor text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX agent_permission_audit_subject_idx
  ON agent_permission_audit (account_id, subject_kind, coalesce(subject_mid, ''), permission, new_version DESC);

CREATE FUNCTION reject_agent_permission_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_permission_audit is append-only';
END;
$$;
CREATE TRIGGER agent_permission_audit_append_only
BEFORE UPDATE OR DELETE ON agent_permission_audit
FOR EACH ROW EXECUTE FUNCTION reject_agent_permission_audit_mutation();
CREATE TRIGGER agent_permission_audit_no_truncate
BEFORE TRUNCATE ON agent_permission_audit
FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_permission_audit_mutation();

-- One folder per chat (group/room folders live under groups\, friend 1:1 under chats\).
-- The directory name is folder_id; files are never deleted with the row.
CREATE TABLE chat_folders (
  folder_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text,
  UNIQUE (account_id, chat_type, chat_id),
  FOREIGN KEY (account_id, chat_type, chat_id) REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE
);

-- Linked folders: an operator-granted, read-mounted group folder for one whitelisted user's jobs.
-- "Not linked" is the absence of a row. The runtime currently honors READ only (WRITE is rejected until path-scoped
-- write rules are verifiable); the column keeps the access vocabulary.
CREATE TABLE agent_folder_links (
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  subject_mid text NOT NULL CHECK (subject_mid <> '' AND length(subject_mid) <= 512),
  folder_id uuid NOT NULL REFERENCES chat_folders(folder_id) ON DELETE CASCADE,
  access text NOT NULL CHECK (access IN ('READ', 'WRITE')),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text,
  PRIMARY KEY (account_id, subject_mid, folder_id)
);
CREATE INDEX agent_folder_links_folder_idx ON agent_folder_links (folder_id);

-- Link changes are audited with permission = 'folder_link' and the folder id.
ALTER TABLE agent_permission_audit ADD COLUMN folder_id uuid;

-- Denied internal MCP calls are audited with their own disposition.
ALTER TABLE mcp_agent_audit DROP CONSTRAINT mcp_agent_audit_disposition_check;
ALTER TABLE mcp_agent_audit ADD CONSTRAINT mcp_agent_audit_disposition_check CHECK (
  disposition IN ('ISSUED', 'REVOKED_BY_OPERATOR', 'ALLOWED', 'AUTH_INVALID', 'REVOKED', 'EXPIRED', 'SCOPE_DENIED', 'RATE_LIMITED', 'INVALID_INPUT', 'PERMISSION_DENIED')
);
