CREATE TABLE external_source_conflicts (
  source_id uuid NOT NULL,
  account_id text NOT NULL,
  generation bigint NOT NULL,
  observation_id text NOT NULL,
  batch_id text NOT NULL,
  canonical_message_id text,
  normalized_digest text NOT NULL CHECK (normalized_digest ~ '^[a-f0-9]{64}$'),
  normalized_payload jsonb NOT NULL,
  conflict_reason text NOT NULL CHECK (conflict_reason IN ('SOURCE_ID_REUSED_WITH_CHANGED_DIGEST')),
  redacted boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, generation, observation_id, batch_id),
  FOREIGN KEY (source_id, generation, observation_id)
    REFERENCES external_source_observations(source_id, generation, observation_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, generation, batch_id)
    REFERENCES external_source_batches(source_id, generation, batch_id) ON DELETE CASCADE
);

CREATE INDEX external_source_conflicts_observed_idx
  ON external_source_conflicts(source_id, generation, observed_at);
