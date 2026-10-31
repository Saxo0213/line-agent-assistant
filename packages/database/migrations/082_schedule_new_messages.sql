-- Program schedule task 'new_messages' (docs/architecture/agent-schedules.md): Main lists the new messages of the window by rules
-- and runs an Agent only for chats whose rule selects the LLM. The task may read all readable chats (empty targets). A run that finds
-- no messages ends as 'no_messages'.
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_task_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_task_check
  CHECK (jsonb_typeof(task) = 'object' AND task->>'type' IN
    ('custom','summary','keyword_digest','message','new_messages'));
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_targets_for_task_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_targets_for_task_check
  CHECK (task->>'type' IN ('custom','message','new_messages')
    OR jsonb_array_length(targets) >= 1);
ALTER TABLE agent_schedules DROP CONSTRAINT agent_schedules_last_outcome_check;
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_last_outcome_check
  CHECK (last_outcome IS NULL OR last_outcome IN
    ('submitting','submitted','missed','skipped_overlap','failed',
     'sent','send_failed','send_unknown','no_messages'));
ALTER TABLE agent_schedule_runs DROP CONSTRAINT agent_schedule_runs_outcome_check;
ALTER TABLE agent_schedule_runs ADD CONSTRAINT agent_schedule_runs_outcome_check
  CHECK (outcome IN
    ('submitting','submitted','missed','skipped_overlap','failed',
     'sent','send_failed','send_unknown','no_messages'));
