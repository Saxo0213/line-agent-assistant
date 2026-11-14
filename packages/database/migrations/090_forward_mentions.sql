-- Mention rules and per-rule actions for message forwarding.
-- A message_forward rule may have empty targets (all readable chats of the AGENT and PRIMARY_ADMIN accounts)
-- and may use record_only delivery when it does not forward.
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_forward_event_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_forward_event_check CHECK (
  (recurrence_kind='message') = (task->>'type'='message_forward') AND
  (task->>'type'<>'message_forward' OR (delivery->>'mode' IN ('line_target','record_only') AND next_fire_at IS NULL)));

ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_targets_for_task_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_targets_for_task_check
  CHECK (task->>'type' IN ('custom','message','new_messages','message_forward')
    OR jsonb_array_length(targets) >= 1);

ALTER TABLE agent_schedule_forward_work
  ADD COLUMN notify_state text CHECK (notify_state IN ('pending','shown','failed')),
  ADD COLUMN agent_state text CHECK (agent_state IN ('pending','submitted','failed','skipped')),
  ADD COLUMN agent_job_id uuid,
  ADD COLUMN agent_error text;
CREATE INDEX agent_schedule_forward_notify_idx ON agent_schedule_forward_work(created_at) WHERE notify_state='pending';
CREATE INDEX agent_schedule_forward_agent_idx ON agent_schedule_forward_work(created_at) WHERE agent_state='pending';

ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_last_outcome_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_last_outcome_check
  CHECK (last_outcome IS NULL OR last_outcome IN
    ('submitting','submitted','missed','skipped_overlap','failed',
     'sent','send_failed','send_unknown','no_messages','notified'));
ALTER TABLE agent_schedule_runs DROP CONSTRAINT agent_schedule_runs_outcome_check;
ALTER TABLE agent_schedule_runs ADD CONSTRAINT agent_schedule_runs_outcome_check
  CHECK (outcome IN
    ('submitting','submitted','missed','skipped_overlap','failed',
     'sent','send_failed','send_unknown','no_messages','notified'));
