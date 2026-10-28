-- Project folders (docs/architecture/project-folders.md): company folders the Primary Administrator binds to one chat with /folder.
-- path is the canonical (realpath) absolute path; the Agent mounts the folders of the chat it works in.
CREATE TABLE agent_project_folders (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL CHECK (chat_id <> ''),
  path text NOT NULL CHECK (path <> '' AND length(path) <= 1024),
  mode text NOT NULL CHECK (mode IN ('READ', 'READ_WRITE')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, chat_type, chat_id, path)
);

-- Bind / update / unbind (and a mount that was skipped at job start) are audited in the permission audit trail.
ALTER TABLE agent_permission_audit DROP CONSTRAINT agent_permission_audit_audit_kind_check;
ALTER TABLE agent_permission_audit ADD CONSTRAINT agent_permission_audit_audit_kind_check
  CHECK (audit_kind IN ('PERMISSION', 'EXECUTION_POLICY', 'ALLOWLIST', 'EXECUTION_APPROVAL', 'GLOBAL_PERMISSION_DEFAULT', 'PROJECT_FOLDER'));
