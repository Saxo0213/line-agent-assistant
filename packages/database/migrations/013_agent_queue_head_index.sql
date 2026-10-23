-- Supports bounded per-account FIFO head lookups during scheduler recovery.
CREATE INDEX agent_jobs_account_queue_head_idx
  ON agent_jobs (account_id, queue_position)
  INCLUDE (chat_type, chat_id, source_type, creation_epoch)
  WHERE status = 'queued';
