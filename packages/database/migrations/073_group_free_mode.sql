-- Group free mode (docs/architecture/group-free-mode.md).
-- room_free_mode: one durable row per chat while free mode is on; expires_at is the end of the window.
-- agent_jobs.free_mode: a LINE job created from a batch of free-mode messages. It runs with the room-member principal
-- (never the admin principal) and its [[NO_REPLY]] output creates no delivery.

CREATE TABLE room_free_mode (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('group', 'room')),
  chat_id text NOT NULL,
  enabled_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_type, chat_id)
);
CREATE INDEX room_free_mode_expires_idx ON room_free_mode (expires_at);

ALTER TABLE agent_jobs ADD COLUMN free_mode boolean NOT NULL DEFAULT false;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_free_mode_line_check CHECK (NOT free_mode OR source_type = 'line');
