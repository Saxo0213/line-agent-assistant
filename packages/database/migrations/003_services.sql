ALTER TABLE line_accounts ADD COLUMN own_mid text;
ALTER TABLE attachments ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0);
ALTER TABLE attachments ADD COLUMN retry_after timestamptz;
ALTER TABLE attachments ADD COLUMN expires_at timestamptz;
CREATE INDEX attachments_recovery_idx ON attachments (status, retry_after, expires_at) WHERE status IN ('queued', 'downloading', 'failed');

ALTER TABLE agent_sessions ADD COLUMN source_type text NOT NULL DEFAULT 'line' CHECK (source_type IN ('line', 'ui'));
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_pkey;
ALTER TABLE agent_sessions ADD PRIMARY KEY (account_id, chat_type, chat_id, provider, source_type);

CREATE TABLE message_routes (
  account_id text NOT NULL,
  message_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('ignore', 'prompt', 'stop', 'new', 'status')),
  provider text CHECK (provider IN ('codex', 'claude')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id) ON DELETE CASCADE
);
