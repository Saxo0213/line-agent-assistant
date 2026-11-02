ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_recurrence_kind_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_recurrence_kind_check
  CHECK (recurrence_kind IN ('once','daily','weekly','interval','cron','message'));
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_task_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_task_check
  CHECK (jsonb_typeof(task)='object' AND task->>'type' IN ('custom','summary','keyword_digest','message','new_messages','message_forward'));
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_forward_event_check CHECK (
  (recurrence_kind='message') = (task->>'type'='message_forward') AND
  (task->>'type'<>'message_forward' OR (delivery->>'mode'='line_target' AND jsonb_array_length(targets)>0 AND next_fire_at IS NULL)));
ALTER TABLE agent_schedules ADD COLUMN rule_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE agent_schedules ADD COLUMN receipt_baseline_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE agent_schedule_forward_work (
  work_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES agent_schedules(schedule_id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  logical_message text NOT NULL,
  account_id text NOT NULL,
  chat_type text NOT NULL,
  chat_id text NOT NULL,
  message_id text NOT NULL,
  sender_id text NOT NULL,
  sender_name text NOT NULL DEFAULT '',
  source_title text NOT NULL DEFAULT '',
  authority jsonb NOT NULL,
  selected_source jsonb NOT NULL,
  run_id uuid NOT NULL REFERENCES agent_schedule_runs(run_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(schedule_id,revision,logical_message)
);
CREATE TABLE agent_schedule_forward_parts (
  work_id uuid NOT NULL REFERENCES agent_schedule_forward_work(work_id) ON DELETE CASCADE,
  part_index integer NOT NULL CHECK(part_index BETWEEN 0 AND 100),
  kind text NOT NULL CHECK(kind IN ('text','image','file','unsupported')),
  text text,
  attachment_id uuid,
  filename text,
  state text NOT NULL CHECK(state IN ('waiting','pending','sending','sent','failed','unknown','cancelled')),
  error_code text,
  PRIMARY KEY(work_id,part_index)
);
CREATE INDEX agent_schedule_forward_pending_idx ON agent_schedule_forward_parts(work_id,part_index)
  WHERE state IN ('waiting','pending','sending');
