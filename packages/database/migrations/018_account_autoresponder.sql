CREATE TABLE account_autoresponder_settings (
  account_id text PRIMARY KEY REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  config_version bigint NOT NULL CHECK (config_version > 0),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  fallback text NOT NULL CHECK (char_length(btrim(fallback)) BETWEEN 1 AND 2000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE autoresponder_rules (
  account_id text NOT NULL REFERENCES account_autoresponder_settings(account_id) ON DELETE CASCADE,
  normalized_trigger text NOT NULL CHECK (char_length(normalized_trigger) BETWEEN 1 AND 256),
  reply text NOT NULL CHECK (char_length(btrim(reply)) BETWEEN 1 AND 2000),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (account_id, normalized_trigger),
  UNIQUE (account_id, ordinal)
);

CREATE TABLE autoresponder_reply_effects (
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  source_message_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('group', 'room')),
  chat_id text NOT NULL,
  reply_text text NOT NULL CHECK (char_length(reply_text) BETWEEN 1 AND 2000),
  state text NOT NULL DEFAULT 'MAY_HAVE_STARTED' CHECK (state IN ('MAY_HAVE_STARTED', 'SENT', 'UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, source_message_id, chat_type, chat_id),
  CHECK ((state = 'MAY_HAVE_STARTED') = (completed_at IS NULL))
);
CREATE INDEX autoresponder_reply_effects_rate_idx ON autoresponder_reply_effects(account_id, chat_type, chat_id, created_at);
