CREATE TABLE line_contacts (
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  mid text NOT NULL CHECK (mid <> '' AND length(mid) <= 512),
  display_name text CHECK (display_name IS NULL OR (display_name <> '' AND length(display_name) <= 256)),
  nickname text CHECK (nickname IS NULL OR (nickname <> '' AND length(nickname) <= 256)),
  native_type integer,
  native_status integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, mid)
);

COMMENT ON TABLE line_contacts IS
  'Per-account LINE friend directory. display_name is the LINE profile name; nickname is the name the account owner set locally (official _contact._displayNameOverridden).';
