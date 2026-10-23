ALTER TABLE external_source_checkpoints
  ADD COLUMN initial_import_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN committed_count bigint NOT NULL DEFAULT 0 CHECK (committed_count >= 0),
  ADD COLUMN high_water jsonb,
  ADD COLUMN eligible_count bigint CHECK (eligible_count IS NULL OR eligible_count >= 0),
  ADD COLUMN import_schema_version text,
  ADD COLUMN snapshot_digest text CHECK (snapshot_digest IS NULL OR snapshot_digest ~ '^[a-f0-9]{64}$');
