ALTER TABLE line_accounts
  ADD COLUMN product_role text CHECK (product_role IN ('AGENT', 'PRIMARY_ADMIN')),
  ADD COLUMN role_revision bigint NOT NULL DEFAULT 0 CHECK (role_revision >= 0),
  ADD COLUMN connection_mode text NOT NULL DEFAULT 'SYSTEM_LOGIN'
    CHECK (connection_mode IN ('SYSTEM_LOGIN', 'EXTERNAL_MONITOR', 'OFFLINE')),
  ADD COLUMN mode_revision bigint NOT NULL DEFAULT 0 CHECK (mode_revision >= 0),
  ADD COLUMN selected_source_id uuid,
  ADD COLUMN selected_source_generation bigint,
  ADD COLUMN source_transition_state text NOT NULL DEFAULT 'STABLE'
    CHECK (source_transition_state IN ('STABLE', 'CANDIDATE_CHECKED', 'OLD_FENCED', 'SELECTED_DRAINING', 'SOURCE_SEALED'));

CREATE TABLE line_account_sources (
  source_id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('SYSTEM_LOGIN', 'EXTERNAL_MONITOR')),
  generation bigint NOT NULL CHECK (generation > 0),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  verified_account_mid text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'FENCED', 'RETIRED')),
  read_capability boolean NOT NULL DEFAULT true,
  write_capability boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (account_id, source_id, generation),
  UNIQUE (account_id, source_type, generation),
  CHECK (source_type <> 'EXTERNAL_MONITOR' OR write_capability = false)
);

ALTER TABLE line_accounts
  ADD CONSTRAINT line_accounts_selected_source_fk
    FOREIGN KEY (account_id, selected_source_id, selected_source_generation)
    REFERENCES line_account_sources(account_id, source_id, generation)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT line_accounts_selected_source_pair_check
    CHECK ((selected_source_id IS NULL) = (selected_source_generation IS NULL));

CREATE TABLE external_source_batches (
  source_id uuid NOT NULL,
  account_id text NOT NULL,
  generation bigint NOT NULL,
  batch_id text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, generation, batch_id),
  FOREIGN KEY (account_id, source_id, generation)
    REFERENCES line_account_sources(account_id, source_id, generation) ON DELETE CASCADE
);

CREATE TABLE external_source_observations (
  source_id uuid NOT NULL,
  account_id text NOT NULL,
  generation bigint NOT NULL,
  observation_id text NOT NULL,
  batch_id text NOT NULL,
  canonical_message_id text,
  normalized_digest text NOT NULL CHECK (normalized_digest ~ '^[a-f0-9]{64}$'),
  normalized_payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('STAGED', 'PROJECTED', 'CONFLICT')),
  conflict_reason text,
  redacted boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, generation, observation_id),
  FOREIGN KEY (account_id, source_id, generation)
    REFERENCES line_account_sources(account_id, source_id, generation) ON DELETE CASCADE,
  FOREIGN KEY (source_id, generation, batch_id)
    REFERENCES external_source_batches(source_id, generation, batch_id) ON DELETE CASCADE
);
CREATE INDEX external_source_observations_projection_idx
  ON external_source_observations(source_id, generation, status, observed_at);

CREATE TABLE external_source_checkpoints (
  source_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  generation bigint NOT NULL,
  cursor jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, source_id, generation)
    REFERENCES line_account_sources(account_id, source_id, generation) ON DELETE CASCADE
);

CREATE TABLE message_source_provenance (
  account_id text NOT NULL,
  message_id text NOT NULL,
  source_id uuid NOT NULL,
  generation bigint NOT NULL,
  observation_id text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('SYSTEM_LOGIN_LIVE', 'SYSTEM_LOGIN_HISTORY', 'EXTERNAL_MONITOR')),
  redacted boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, generation, observation_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, message_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, generation, observation_id)
    REFERENCES external_source_observations(source_id, generation, observation_id) ON DELETE CASCADE
);
