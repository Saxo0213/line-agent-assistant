CREATE TABLE attachment_storage_settings (
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL CHECK (chat_id <> ''),
  secondary_root text,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, chat_type, chat_id),
  CHECK (secondary_root IS NULL OR (secondary_root <> '' AND length(secondary_root) <= 1024))
);

CREATE TABLE attachment_storage_jobs (
  job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL CHECK (chat_id <> ''),
  attachment_id uuid NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('secondary', 'reclassify')),
  generation bigint NOT NULL CHECK (generation >= 0),
  target_relative_path text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'failed', 'completed', 'superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[A-Z0-9_]{2,48}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attachment_id, target_kind),
  CHECK ((status = 'claimed') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE INDEX attachment_storage_jobs_claim_idx ON attachment_storage_jobs (available_at, job_id)
  WHERE status IN ('queued', 'failed', 'claimed');
CREATE INDEX attachment_storage_jobs_chat_idx ON attachment_storage_jobs (account_id, chat_type, chat_id, status, target_kind);
