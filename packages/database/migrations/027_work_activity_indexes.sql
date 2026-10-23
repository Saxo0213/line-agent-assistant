CREATE INDEX attachments_work_activity_idx
  ON attachments (updated_at DESC, attachment_id DESC)
  INCLUDE (account_id, chat_type, chat_id, kind, status, retry_count);

CREATE INDEX attachments_terminal_error_activity_idx
  ON attachments (updated_at DESC, attachment_id DESC)
  INCLUDE (account_id, chat_type, chat_id, kind, status, retry_count)
  WHERE status = 'expired' OR (status = 'failed' AND retry_count >= 3);
