-- CLI account sources: one provider (claude or codex) can have several accounts.
-- A system source is a fixed row whose id equals its provider. A managed source has the id acct-<10 hex>.
CREATE TABLE agent_account_sources (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider text NOT NULL CHECK (provider IN ('claude','codex')),
  kind text NOT NULL CHECK (kind IN ('system','managed')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  is_default boolean NOT NULL DEFAULT false,
  fallback_enabled boolean NOT NULL DEFAULT true,
  fallback_position integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_account_sources_system_check CHECK (kind <> 'system' OR (source_id = provider AND NOT is_default)),
  CONSTRAINT agent_account_sources_managed_check CHECK (kind <> 'managed' OR source_id NOT IN ('claude','codex'))
);
-- Only one explicit default per provider. No explicit default means the system source is the default.
CREATE UNIQUE INDEX agent_account_sources_default_idx ON agent_account_sources (provider) WHERE is_default;

INSERT INTO agent_account_sources (source_id, provider, kind, label, created_at, updated_at) VALUES
  ('claude', 'claude', 'system', 'Claude', 'epoch', 'epoch'),
  ('codex', 'codex', 'system', 'Codex', 'epoch', 'epoch')
ON CONFLICT (source_id) DO NOTHING;

-- A chat session binds to one source at its first run. A removed source clears the binding.
ALTER TABLE agent_sessions ADD COLUMN account_source_id text NULL REFERENCES agent_account_sources(source_id);
UPDATE agent_sessions SET account_source_id = provider WHERE external_session_id IS NOT NULL;

ALTER TABLE agent_jobs ADD COLUMN account_source_id text NULL REFERENCES agent_account_sources(source_id) ON DELETE SET NULL;

-- Quota state is per source. The provider column stays; the application writes the provider of the source row.
ALTER TABLE provider_quota_state ADD COLUMN source_id text;
UPDATE provider_quota_state SET source_id = provider;
ALTER TABLE provider_quota_state ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE provider_quota_state DROP CONSTRAINT provider_quota_state_pkey;
ALTER TABLE provider_quota_state ADD PRIMARY KEY (source_id);
ALTER TABLE provider_quota_state ADD CONSTRAINT provider_quota_state_source_fk
  FOREIGN KEY (source_id) REFERENCES agent_account_sources(source_id) ON DELETE CASCADE;
