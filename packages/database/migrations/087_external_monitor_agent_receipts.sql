CREATE TABLE external_monitor_agent_receipts (
  source_id uuid NOT NULL,
  generation bigint NOT NULL,
  observation_id text NOT NULL,
  monitored_account_id text NOT NULL,
  agent_account_id text NOT NULL REFERENCES line_accounts(account_id) ON DELETE CASCADE,
  mode_revision bigint NOT NULL,
  admin_binding_mid text NOT NULL,
  admin_binding_version bigint NOT NULL,
  control_epoch bigint NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  source_chat_id text NOT NULL,
  target_chat_id text NOT NULL,
  sender_id text NOT NULL,
  message_id text NOT NULL,
  observation jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (source_id, generation, observation_id),
  FOREIGN KEY (monitored_account_id, source_id, generation)
    REFERENCES line_account_sources(account_id, source_id, generation) ON DELETE CASCADE,
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX external_monitor_agent_receipts_pending_idx
  ON external_monitor_agent_receipts(agent_account_id, control_epoch, created_at)
  WHERE state = 'pending';

ALTER TABLE message_routes ADD COLUMN monitor_source_id uuid;
ALTER TABLE message_routes ADD COLUMN monitor_origin boolean NOT NULL DEFAULT false;
ALTER TABLE message_routes ADD COLUMN monitor_generation bigint;
ALTER TABLE message_routes ADD COLUMN monitor_observation_id text;
ALTER TABLE message_routes ADD CONSTRAINT message_routes_monitor_receipt_fk
  FOREIGN KEY(monitor_source_id,monitor_generation,monitor_observation_id)
  REFERENCES external_monitor_agent_receipts(source_id,generation,observation_id) ON DELETE SET NULL;
