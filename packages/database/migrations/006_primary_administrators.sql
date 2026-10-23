CREATE TABLE account_administrators (
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  chat_type text NOT NULL CHECK (chat_type = 'direct'),
  chat_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role = 'PRIMARY_ADMIN'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_type, chat_id, user_id),
  UNIQUE (account_id, role)
);
