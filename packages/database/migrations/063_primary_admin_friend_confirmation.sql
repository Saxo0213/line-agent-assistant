CREATE TABLE primary_administrator_friend_confirmations (
  account_id text PRIMARY KEY REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  admin_version bigint NOT NULL CHECK (admin_version > 0),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
