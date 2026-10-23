CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_accounts (
  account_id text PRIMARY KEY,
  display_name text,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'degraded')),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  title text NOT NULL DEFAULT '',
  agent_enabled boolean NOT NULL DEFAULT false,
  default_provider text NOT NULL DEFAULT 'codex' CHECK (default_provider IN ('codex', 'claude')),
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id)
);

CREATE TABLE conversation_members (
  account_id text NOT NULL,
  chat_id text NOT NULL,
  member_id text NOT NULL,
  display_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id, member_id),
  FOREIGN KEY (account_id, chat_id) REFERENCES conversations(account_id, chat_id) ON DELETE CASCADE
);

CREATE TABLE messages (
  account_id text NOT NULL,
  message_id text NOT NULL,
  event_id text NOT NULL,
  chat_id text NOT NULL,
  sender_id text NOT NULL,
  kind text NOT NULL,
  text_content text,
  reply_to_message_id text,
  mention_ids jsonb NOT NULL DEFAULT '[]',
  mention_ranges jsonb NOT NULL DEFAULT '[]',
  ingestion_source text NOT NULL CHECK (ingestion_source IN ('live', 'history')),
  occurred_at timestamptz NOT NULL,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, chat_id) REFERENCES conversations(account_id, chat_id) ON DELETE CASCADE
);
CREATE INDEX messages_chronology_idx ON messages (account_id, chat_id, occurred_at DESC, message_id DESC);
CREATE INDEX messages_sender_date_idx ON messages (account_id, sender_id, occurred_at DESC);
CREATE INDEX messages_text_search_idx ON messages USING gin (to_tsvector('simple', coalesce(text_content, '')));

CREATE TABLE message_revisions (
  revision_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  message_id text NOT NULL,
  text_content text,
  raw jsonb,
  revised_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id) ON DELETE CASCADE
);

CREATE TABLE message_reactions (
  account_id text NOT NULL,
  message_id text NOT NULL,
  reactor_id text NOT NULL,
  reaction text NOT NULL,
  reacted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, message_id, reactor_id, reaction),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id) ON DELETE CASCADE
);

CREATE TABLE attachments (
  attachment_id text PRIMARY KEY,
  account_id text NOT NULL,
  message_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  name text,
  mime_type text,
  size_bytes bigint CHECK (size_bytes >= 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'downloading', 'ready', 'failed', 'expired')),
  relative_path text,
  sha256 text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id) ON DELETE CASCADE,
  CHECK (status <> 'ready' OR (relative_path IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX attachments_message_idx ON attachments (account_id, message_id);

CREATE TABLE sync_cursors (
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('live', 'history')),
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, source)
);

CREATE TABLE agent_sessions (
  account_id text NOT NULL,
  chat_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex', 'claude')),
  external_session_id text,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id, provider),
  FOREIGN KEY (account_id, chat_id) REFERENCES conversations(account_id, chat_id) ON DELETE CASCADE
);

CREATE TABLE agent_jobs (
  job_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  chat_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex', 'claude')),
  source_type text NOT NULL CHECK (source_type IN ('line', 'ui')),
  source_message_id text,
  source_request_id text,
  prompt text NOT NULL,
  workspace_path text NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, chat_id) REFERENCES conversations(account_id, chat_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, source_message_id) REFERENCES messages(account_id, message_id),
  CHECK ((source_type = 'line' AND source_message_id IS NOT NULL AND source_request_id IS NULL)
    OR (source_type = 'ui' AND source_message_id IS NULL AND source_request_id IS NOT NULL))
);
CREATE UNIQUE INDEX agent_jobs_line_source_idx ON agent_jobs (account_id, source_message_id) WHERE source_type = 'line';
CREATE UNIQUE INDEX agent_jobs_ui_source_idx ON agent_jobs (account_id, chat_id, source_request_id) WHERE source_type = 'ui';
CREATE UNIQUE INDEX agent_jobs_one_running_chat_idx ON agent_jobs (account_id, chat_id) WHERE status = 'running';
CREATE INDEX agent_jobs_claim_idx ON agent_jobs (account_id, chat_id, created_at) WHERE status = 'queued';

CREATE TABLE agent_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_job_idx ON agent_events (job_id, event_id);

CREATE TABLE agent_outputs (
  job_id uuid PRIMARY KEY REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  final_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_deliveries (
  delivery_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  part_index integer NOT NULL CHECK (part_index >= 0),
  text_content text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'unknown')),
  line_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, part_index)
);
CREATE INDEX agent_deliveries_status_idx ON agent_deliveries (status, created_at);

CREATE TABLE work_records (
  work_record_id uuid PRIMARY KEY,
  job_id uuid REFERENCES agent_jobs(job_id),
  title text NOT NULL,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_record_messages (
  work_record_id uuid NOT NULL REFERENCES work_records(work_record_id) ON DELETE CASCADE,
  account_id text NOT NULL,
  message_id text NOT NULL,
  PRIMARY KEY (work_record_id, account_id, message_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id)
);

CREATE TABLE audit_logs (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  actor text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
