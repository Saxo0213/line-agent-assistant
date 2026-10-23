-- One local Agent room owned by the operator, independent of every LINE account.
-- UI jobs and UI sessions lose their account/chat key; LINE rows keep it and keep every existing constraint.
-- The composite foreign keys use MATCH SIMPLE, so NULL columns skip them while LINE rows stay fully enforced.

ALTER TABLE agent_jobs ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE agent_jobs ALTER COLUMN chat_type DROP NOT NULL;
ALTER TABLE agent_jobs ALTER COLUMN chat_id DROP NOT NULL;

ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_pkey;
ALTER TABLE agent_sessions ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE agent_sessions ALTER COLUMN chat_type DROP NOT NULL;
ALTER TABLE agent_sessions ALTER COLUMN chat_id DROP NOT NULL;

-- A UI job that was still running belongs to a process that no longer exists (migrations run before the Agent
-- service starts), and the account-less room allows at most one running job.
UPDATE agent_jobs SET status = 'interrupted', completed_at = COALESCE(completed_at, clock_timestamp()),
  updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
WHERE source_type = 'ui' AND status = 'running';

-- Request ids were unique per account; they must now be unique for the whole room.
UPDATE agent_jobs j SET source_request_id = j.source_request_id || ':' || j.job_id::text
FROM (
  SELECT job_id, row_number() OVER (PARTITION BY source_request_id ORDER BY created_at, queue_position) AS position
  FROM agent_jobs WHERE source_type = 'ui'
) duplicate
WHERE duplicate.job_id = j.job_id AND duplicate.position > 1;

-- One UI session per provider survives: the one holding a provider session, then the most recently used.
-- Its generation is the highest seen so no merged job is newer than its session.
CREATE TEMPORARY TABLE agent_room_session_merge ON COMMIT DROP AS
SELECT DISTINCT ON (provider) provider, account_id, chat_type, chat_id,
  max(generation) OVER (PARTITION BY provider) AS generation
FROM agent_sessions WHERE source_type = 'ui'
ORDER BY provider, (external_session_id IS NOT NULL) DESC, updated_at DESC, account_id, chat_type, chat_id;

DELETE FROM agent_sessions s
WHERE s.source_type = 'ui'
  AND NOT EXISTS (SELECT 1 FROM agent_room_session_merge m
    WHERE m.provider = s.provider AND m.account_id = s.account_id AND m.chat_type = s.chat_type AND m.chat_id = s.chat_id);

UPDATE agent_sessions s SET account_id = NULL, chat_type = NULL, chat_id = NULL, generation = m.generation
FROM agent_room_session_merge m
WHERE s.source_type = 'ui' AND s.provider = m.provider AND s.account_id = m.account_id
  AND s.chat_type = m.chat_type AND s.chat_id = m.chat_id;

-- Both accounts' UI history becomes one room, ordered by created_at / queue_position.
UPDATE agent_jobs SET account_id = NULL, chat_type = NULL, chat_id = NULL WHERE source_type = 'ui';

ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_ui_account_less_check CHECK (
  (source_type = 'ui' AND account_id IS NULL AND chat_type IS NULL AND chat_id IS NULL)
  OR (source_type = 'line' AND account_id IS NOT NULL AND chat_type IS NOT NULL AND chat_id IS NOT NULL));
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_ui_account_less_check CHECK (
  (source_type = 'ui' AND account_id IS NULL AND chat_type IS NULL AND chat_id IS NULL)
  OR (source_type = 'line' AND account_id IS NOT NULL AND chat_type IS NOT NULL AND chat_id IS NOT NULL));

DROP INDEX agent_jobs_ui_source_idx;
CREATE UNIQUE INDEX agent_jobs_ui_source_idx ON agent_jobs (source_request_id) WHERE source_type = 'ui';
CREATE UNIQUE INDEX agent_jobs_one_running_ui_idx ON agent_jobs ((true)) WHERE source_type = 'ui' AND status = 'running';
CREATE INDEX agent_jobs_ui_queue_head_idx ON agent_jobs (queue_position) WHERE source_type = 'ui' AND status = 'queued';
CREATE INDEX agent_jobs_ui_history_idx ON agent_jobs (created_at DESC, job_id DESC) WHERE source_type = 'ui';

-- LINE sessions keep their composite uniqueness; account-less UI sessions are unique per provider.
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_line_key UNIQUE (account_id, chat_type, chat_id, provider, source_type);
CREATE UNIQUE INDEX agent_sessions_ui_key ON agent_sessions (provider) WHERE source_type = 'ui';
