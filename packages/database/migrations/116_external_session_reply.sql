-- External MCP sessions and the replies of the Primary Admin (docs/design/external-session-reply.md).
-- A session is created by send_to_target with a session key. The number `seq` is unique for each Agent account.
CREATE TABLE external_sessions (
  session_key text PRIMARY KEY CHECK (session_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  account_id text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 24),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  UNIQUE (account_id, seq)
);
CREATE INDEX external_sessions_open_idx ON external_sessions (last_seen_at) WHERE closed_at IS NULL;

-- One row for each LINE message that was sent for a session. A quoted reply of the admin is matched to a session by this row.
CREATE TABLE external_session_messages (
  account_id text NOT NULL,
  line_message_id text NOT NULL CHECK (line_message_id <> ''),
  session_key text NOT NULL REFERENCES external_sessions(session_key) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, line_message_id)
);
CREATE INDEX external_session_messages_session_idx ON external_session_messages (session_key, sent_at DESC);

-- One row for each message of the admin that was given to a session. An inbound message can go to one session only.
CREATE TABLE external_session_replies (
  reply_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('quote', 'agent')),
  inbound_message_id text NOT NULL UNIQUE CHECK (inbound_message_id <> ''),
  text text NOT NULL DEFAULT '',
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz
);
CREATE INDEX external_session_replies_session_idx ON external_session_replies (session_key, created_at, reply_id);
CREATE INDEX external_session_replies_pending_idx ON external_session_replies (session_key, created_at) WHERE delivered_at IS NULL;

-- A reply row is append-only. The only allowed change is delivered_at from NULL to a time.
CREATE FUNCTION guard_external_session_replies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL
    AND NEW.reply_id = OLD.reply_id AND NEW.session_key = OLD.session_key AND NEW.source = OLD.source
    AND NEW.inbound_message_id = OLD.inbound_message_id AND NEW.text = OLD.text
    AND NEW.attachment_ids = OLD.attachment_ids AND NEW.note IS NOT DISTINCT FROM OLD.note
    AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'external_session_replies is append-only; only delivered_at can change from NULL to a time';
END;
$$;

CREATE TRIGGER external_session_replies_guard
BEFORE UPDATE OR DELETE ON external_session_replies
FOR EACH ROW EXECUTE FUNCTION guard_external_session_replies();

CREATE TRIGGER external_session_replies_no_truncate
BEFORE TRUNCATE ON external_session_replies
FOR EACH STATEMENT EXECUTE FUNCTION guard_external_session_replies();
