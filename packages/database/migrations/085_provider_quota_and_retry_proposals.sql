ALTER TABLE agent_jobs ADD COLUMN retry_of_job_id uuid REFERENCES agent_jobs(job_id) ON DELETE CASCADE;
DROP INDEX agent_jobs_line_source_idx;
CREATE UNIQUE INDEX agent_jobs_line_source_idx ON agent_jobs (account_id, source_message_id)
  WHERE source_type = 'line' AND retry_of_job_id IS NULL;
CREATE UNIQUE INDEX agent_jobs_quota_retry_source_idx ON agent_jobs (retry_of_job_id)
  WHERE retry_of_job_id IS NOT NULL;

CREATE TABLE provider_quota_state (
  provider text PRIMARY KEY CHECK (provider IN ('claude','codex')),
  blocked boolean NOT NULL DEFAULT false,
  observed_at timestamptz,
  recovery_at timestamptz,
  evidence_source text,
  evidence text,
  snapshot jsonb,
  snapshot_fetched_at timestamptz,
  snapshot_stale boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_quota_proposals (
  job_id uuid PRIMARY KEY REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  retry_job_id uuid UNIQUE REFERENCES agent_jobs(job_id) ON DELETE SET NULL,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct','group','room')),
  chat_id text NOT NULL,
  source_message_id text NOT NULL,
  source_sender_id text NOT NULL,
  control_epoch bigint NOT NULL,
  failed_provider text NOT NULL CHECK (failed_provider IN ('claude','codex')),
  target_provider text NOT NULL CHECK (target_provider IN ('claude','codex')),
  direct_grant_id uuid,
  direct_grant_version bigint,
  room_grant_id uuid,
  room_grant_version bigint,
  notification_state text NOT NULL DEFAULT 'pending' CHECK (notification_state IN ('pending','claimed','sent','unknown','failed')),
  confirmation_message_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','expired','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (failed_provider <> target_provider)
);
CREATE UNIQUE INDEX provider_quota_proposal_confirmation_idx ON provider_quota_proposals(account_id, confirmation_message_id)
  WHERE confirmation_message_id IS NOT NULL;

CREATE TABLE provider_quota_notices (
  job_id uuid PRIMARY KEY REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  notification_state text NOT NULL DEFAULT 'pending' CHECK (notification_state IN ('pending','claimed','sent','unknown','failed','skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
