ALTER TABLE line_accounts
  ADD COLUMN mode text NOT NULL DEFAULT 'MONITOR_ONLY'
    CHECK (mode IN ('ACTIVE_CONTROL', 'MONITOR_ONLY', 'PAUSED'));

CREATE UNIQUE INDEX line_accounts_one_active_idx ON line_accounts ((1)) WHERE mode = 'ACTIVE_CONTROL';

CREATE TABLE account_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  control_epoch bigint NOT NULL DEFAULT 1 CHECK (control_epoch >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO account_control (singleton, control_epoch) VALUES (true, 1);

ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_account_id_chat_id_fkey;
ALTER TABLE messages DROP CONSTRAINT messages_account_id_chat_id_fkey;
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_account_id_chat_id_fkey;
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_account_id_chat_id_fkey;

ALTER TABLE conversations DROP CONSTRAINT conversations_pkey;
ALTER TABLE conversations ADD PRIMARY KEY (account_id, chat_type, chat_id);

ALTER TABLE conversation_members ADD COLUMN chat_type text;
UPDATE conversation_members cm SET chat_type = c.chat_type
FROM conversations c WHERE c.account_id = cm.account_id AND c.chat_id = cm.chat_id;
ALTER TABLE conversation_members ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE conversation_members ADD CHECK (chat_type IN ('direct', 'group', 'room'));
ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_pkey;
ALTER TABLE conversation_members ADD PRIMARY KEY (account_id, chat_type, chat_id, member_id);
ALTER TABLE conversation_members ADD FOREIGN KEY (account_id, chat_type, chat_id)
  REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE;

ALTER TABLE messages ADD COLUMN chat_type text;
UPDATE messages m SET chat_type = c.chat_type
FROM conversations c WHERE c.account_id = m.account_id AND c.chat_id = m.chat_id;
ALTER TABLE messages ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE messages ADD CHECK (chat_type IN ('direct', 'group', 'room'));
ALTER TABLE messages ADD FOREIGN KEY (account_id, chat_type, chat_id)
  REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE;
ALTER TABLE messages ADD UNIQUE (account_id, chat_type, chat_id, message_id);
DROP INDEX messages_chronology_idx;
CREATE INDEX messages_chronology_idx ON messages (account_id, chat_type, chat_id, occurred_at DESC, message_id DESC);

ALTER TABLE attachments RENAME COLUMN attachment_id TO external_attachment_id;
ALTER TABLE attachments DROP CONSTRAINT attachments_pkey;
ALTER TABLE attachments ADD COLUMN attachment_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE attachments ADD COLUMN chat_type text;
ALTER TABLE attachments ADD COLUMN chat_id text;
ALTER TABLE attachments ADD COLUMN download_worker_instance_id text;
UPDATE attachments a SET chat_type = m.chat_type, chat_id = m.chat_id
FROM messages m WHERE m.account_id = a.account_id AND m.message_id = a.message_id;
ALTER TABLE attachments ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN chat_id SET NOT NULL;
ALTER TABLE attachments ADD CHECK (chat_type IN ('direct', 'group', 'room'));
ALTER TABLE attachments ADD PRIMARY KEY (attachment_id);
ALTER TABLE attachments ADD UNIQUE (account_id, chat_type, chat_id, message_id, external_attachment_id);
ALTER TABLE attachments DROP CONSTRAINT attachments_account_id_message_id_fkey;
ALTER TABLE attachments ADD FOREIGN KEY (account_id, chat_type, chat_id, message_id)
  REFERENCES messages(account_id, chat_type, chat_id, message_id) ON DELETE CASCADE;
DROP INDEX attachments_message_idx;
CREATE INDEX attachments_message_idx ON attachments (account_id, chat_type, chat_id, message_id);

ALTER TABLE agent_sessions ADD COLUMN chat_type text;
UPDATE agent_sessions s SET chat_type = c.chat_type
FROM conversations c WHERE c.account_id = s.account_id AND c.chat_id = s.chat_id;
ALTER TABLE agent_sessions ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE agent_sessions ADD CHECK (chat_type IN ('direct', 'group', 'room'));
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_pkey;
ALTER TABLE agent_sessions ADD PRIMARY KEY (account_id, chat_type, chat_id, provider);
ALTER TABLE agent_sessions ADD FOREIGN KEY (account_id, chat_type, chat_id)
  REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE;

ALTER TABLE agent_jobs ADD COLUMN chat_type text;
UPDATE agent_jobs j SET chat_type = c.chat_type
FROM conversations c WHERE c.account_id = j.account_id AND c.chat_id = j.chat_id;
ALTER TABLE agent_jobs ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE agent_jobs ADD CHECK (chat_type IN ('direct', 'group', 'room'));
ALTER TABLE agent_jobs ADD COLUMN creation_epoch bigint;
UPDATE agent_jobs SET creation_epoch = 0 WHERE source_type = 'line';
ALTER TABLE agent_jobs ADD CHECK (
  (source_type = 'line' AND creation_epoch IS NOT NULL AND creation_epoch >= 0)
  OR (source_type = 'ui' AND creation_epoch IS NULL)
);
UPDATE agent_jobs SET status = 'cancelled', completed_at = COALESCE(completed_at, now()), updated_at = now()
WHERE source_type = 'line' AND status IN ('queued', 'running');
ALTER TABLE agent_jobs ADD FOREIGN KEY (account_id, chat_type, chat_id)
  REFERENCES conversations(account_id, chat_type, chat_id) ON DELETE CASCADE;
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_account_id_source_message_id_fkey;
ALTER TABLE agent_jobs ADD FOREIGN KEY (account_id, chat_type, chat_id, source_message_id)
  REFERENCES messages(account_id, chat_type, chat_id, message_id);
DROP INDEX agent_jobs_line_source_idx;
DROP INDEX agent_jobs_ui_source_idx;
DROP INDEX agent_jobs_one_running_chat_idx;
DROP INDEX agent_jobs_claim_idx;
CREATE UNIQUE INDEX agent_jobs_line_source_idx ON agent_jobs (account_id, source_message_id) WHERE source_type = 'line';
CREATE UNIQUE INDEX agent_jobs_ui_source_idx ON agent_jobs (account_id, chat_type, chat_id, source_request_id) WHERE source_type = 'ui';
CREATE UNIQUE INDEX agent_jobs_one_running_chat_idx ON agent_jobs (account_id, chat_type, chat_id) WHERE status = 'running';
CREATE INDEX agent_jobs_claim_idx ON agent_jobs (account_id, chat_type, chat_id, created_at) WHERE status = 'queued';

ALTER TABLE agent_deliveries DROP CONSTRAINT agent_deliveries_status_check;
ALTER TABLE agent_deliveries ADD CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'cancelled'));
ALTER TABLE agent_deliveries ADD COLUMN account_id text;
ALTER TABLE agent_deliveries ADD COLUMN chat_type text;
ALTER TABLE agent_deliveries ADD COLUMN chat_id text;
ALTER TABLE agent_deliveries ADD COLUMN creation_epoch bigint;
UPDATE agent_deliveries d SET account_id = j.account_id, chat_type = j.chat_type,
  chat_id = j.chat_id, creation_epoch = j.creation_epoch
FROM agent_jobs j WHERE j.job_id = d.job_id;
UPDATE agent_deliveries SET status = CASE WHEN status = 'sending' THEN 'unknown' ELSE 'cancelled' END, updated_at = now()
WHERE status IN ('pending', 'sending');
ALTER TABLE agent_deliveries ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE agent_deliveries ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE agent_deliveries ALTER COLUMN chat_id SET NOT NULL;
ALTER TABLE agent_deliveries ADD CHECK (chat_type IN ('direct', 'group', 'room'));
ALTER TABLE agent_deliveries ADD CHECK (creation_epoch IS NULL OR creation_epoch >= 0);

ALTER TABLE work_records ADD COLUMN account_id text;
ALTER TABLE work_records ADD COLUMN chat_type text;
ALTER TABLE work_records ADD COLUMN chat_id text;
UPDATE work_records w SET account_id = j.account_id, chat_type = j.chat_type, chat_id = j.chat_id
FROM agent_jobs j WHERE j.job_id = w.job_id;

ALTER TABLE work_record_messages ADD COLUMN chat_type text;
ALTER TABLE work_record_messages ADD COLUMN chat_id text;
UPDATE work_record_messages wrm SET chat_type = m.chat_type, chat_id = m.chat_id
FROM messages m WHERE m.account_id = wrm.account_id AND m.message_id = wrm.message_id;
ALTER TABLE work_record_messages ALTER COLUMN chat_type SET NOT NULL;
ALTER TABLE work_record_messages ALTER COLUMN chat_id SET NOT NULL;
ALTER TABLE work_record_messages DROP CONSTRAINT work_record_messages_account_id_message_id_fkey;
ALTER TABLE work_record_messages ADD FOREIGN KEY (account_id, chat_type, chat_id, message_id)
  REFERENCES messages(account_id, chat_type, chat_id, message_id);
