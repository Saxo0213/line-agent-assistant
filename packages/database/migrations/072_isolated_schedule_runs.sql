-- Isolated scheduled runs and system message schedules (docs/architecture/agent-schedules.md).
--
-- 1. agent_jobs gains source_type 'schedule'. A scheduled run is NOT an Agent room job: it has its own queue, its own single
--    running slot and never reads or writes any agent_sessions row (every run starts a brand-new provider session). Like a room
--    job it has no LINE account or chat (NULL account_id / chat_type / chat_id), generation 0 and no creation epoch. It is
--    identified by source_request_id = 'schedule:<scheduleId>:<scheduledFor ISO>' (reused instead of new columns: the id is
--    already deterministic per schedule slot, so it is also the idempotency key), unique among schedule jobs.
-- 2. agent_schedules: task type 'message' (a system message sent by Main, no Agent job), delivery mode 'record_only' replaces
--    'agent_room' (existing agent_room rows are converted), and run outcomes sent / send_failed / send_unknown.

-- ---- agent_jobs ----
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_source_type_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_source_type_check CHECK (source_type IN ('line', 'ui', 'schedule'));

-- 001: a LINE job names its message; a UI job names its request id. A schedule job names its request id like a UI job.
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_source_shape_check CHECK (
  (source_type = 'line' AND source_message_id IS NOT NULL AND source_request_id IS NULL)
  OR (source_type IN ('ui', 'schedule') AND source_message_id IS NULL AND source_request_id IS NOT NULL));

-- 008/009: only LINE jobs carry a control epoch.
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_check1;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_epoch_shape_check CHECK (
  (source_type = 'line' AND creation_epoch IS NOT NULL AND creation_epoch >= 0)
  OR (source_type IN ('ui', 'schedule') AND creation_epoch IS NULL));

-- 040: UI jobs are account-less; schedule jobs are account-less too.
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_ui_account_less_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_ui_account_less_check CHECK (
  (source_type IN ('ui', 'schedule') AND account_id IS NULL AND chat_type IS NULL AND chat_id IS NULL)
  OR (source_type = 'line' AND account_id IS NOT NULL AND chat_type IS NOT NULL AND chat_id IS NOT NULL));

ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_schedule_shape_check CHECK (
  source_type <> 'schedule' OR (starts_with(source_request_id, 'schedule:') AND generation = 0));

-- Idempotent enqueue per schedule slot, one running scheduled run at a time, and the schedule queue head / history.
CREATE UNIQUE INDEX agent_jobs_schedule_source_idx ON agent_jobs (source_request_id) WHERE source_type = 'schedule';
CREATE UNIQUE INDEX agent_jobs_one_running_schedule_idx ON agent_jobs ((true)) WHERE source_type = 'schedule' AND status = 'running';
CREATE INDEX agent_jobs_schedule_queue_head_idx ON agent_jobs (queue_position) WHERE source_type = 'schedule' AND status = 'queued';
CREATE INDEX agent_jobs_schedule_history_idx ON agent_jobs (created_at DESC, job_id DESC) WHERE source_type = 'schedule';

-- ---- agent_schedules ----
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_delivery_mode_check;
UPDATE agent_schedules SET delivery = '{"mode":"record_only"}'::jsonb WHERE delivery->>'mode' = 'agent_room';
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_delivery_mode_check
  CHECK (jsonb_typeof(delivery) = 'object' AND delivery->>'mode' IN ('primary_admin', 'record_only', 'line_target'));

ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_task_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_task_check
  CHECK (jsonb_typeof(task) = 'object' AND task->>'type' IN ('custom', 'summary', 'keyword_digest', 'message'));

-- 069: every non-custom task reads chats. A message task reads none and carries its text (1..5000 characters) in the task.
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_check2;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_targets_for_task_check CHECK (
  task->>'type' IN ('custom', 'message') OR jsonb_array_length(targets) >= 1);
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_message_task_check CHECK (
  task->>'type' <> 'message' OR (
    COALESCE(jsonb_typeof(task->'text'), '') = 'string' AND char_length(task->>'text') BETWEEN 1 AND 5000
    AND jsonb_array_length(targets) = 0 AND delivery->>'mode' <> 'record_only'));

ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_last_outcome_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_last_outcome_check CHECK (
  last_outcome IS NULL OR last_outcome IN ('submitting', 'submitted', 'missed', 'skipped_overlap', 'failed', 'sent', 'send_failed', 'send_unknown'));

-- ---- agent_schedule_runs ----
ALTER TABLE agent_schedule_runs DROP CONSTRAINT agent_schedule_runs_outcome_check;
ALTER TABLE agent_schedule_runs ADD CONSTRAINT agent_schedule_runs_outcome_check CHECK (
  outcome IN ('submitting', 'submitted', 'missed', 'skipped_overlap', 'failed', 'sent', 'send_failed', 'send_unknown'));
