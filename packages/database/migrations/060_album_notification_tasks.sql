CREATE TABLE album_notification_tasks (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'retry', 'completed', 'skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  error_stage text CHECK (error_stage IN ('archive_scan', 'source_validation', 'unknown')),
  error_code text CHECK (error_code IN ('ALBUM_RECONCILIATION_FAILED', 'ALBUM_ARCHIVE_INCOMPLETE',
    'ALBUM_PHOTO_CURSOR_LOOP', 'missing_source', 'source_deleted', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_type, chat_id, message_id),
  CHECK ((status = 'retry') = (next_attempt_at IS NOT NULL)),
  CHECK ((status IN ('retry', 'skipped')) = (error_stage IS NOT NULL AND error_code IS NOT NULL))
);

CREATE INDEX album_notification_tasks_due_idx
  ON album_notification_tasks (account_id, status, next_attempt_at, chat_type, chat_id, message_id);
