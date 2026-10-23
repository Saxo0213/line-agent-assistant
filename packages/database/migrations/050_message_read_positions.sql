CREATE TABLE message_read_positions (
  account_id text NOT NULL,
  chat_type text NOT NULL,
  chat_id text NOT NULL,
  reader_mid text NOT NULL,
  last_read_message_id text NOT NULL,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, chat_type, chat_id, reader_mid)
);
