-- Account-local monotonic signed-i32 LINE request sequence reservations.
-- Keep these rows independent of line_accounts so deleting/re-adding an account
-- identifier cannot make an old on-wire sequence available again.
CREATE TABLE line_request_sequence_counters (
  account_id text PRIMARY KEY,
  next_sequence bigint NOT NULL DEFAULT 1
    CHECK (next_sequence BETWEEN 1 AND 2147483648),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_request_sequence_reservations (
  reservation_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, sequence),
  UNIQUE (account_id, reservation_id)
);
CREATE INDEX line_request_sequence_reservations_account_idx
  ON line_request_sequence_reservations(account_id, sequence DESC);

CREATE TABLE line_mutation_intents (
  intent_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  grant_version bigint NOT NULL CHECK (grant_version >= 0),
  capability text NOT NULL,
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED', 'ATTEMPT_RESERVED', 'IN_FLIGHT', 'SENT', 'REJECTED', 'UNKNOWN')),
  attempt_id text,
  owner_id text,
  worker_instance_id text,
  credential_version bigint,
  reservation_id uuid,
  effect_permit_id text,
  outcome jsonb,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'PREPARED' AND attempt_id IS NULL AND owner_id IS NULL AND worker_instance_id IS NULL
      AND credential_version IS NULL AND reservation_id IS NULL AND effect_permit_id IS NULL)
    OR (state <> 'PREPARED' AND attempt_id IS NOT NULL AND owner_id IS NOT NULL AND worker_instance_id IS NOT NULL
      AND credential_version IS NOT NULL AND reservation_id IS NOT NULL AND effect_permit_id IS NOT NULL)),
  CHECK ((state IN ('SENT', 'REJECTED', 'UNKNOWN')) = (outcome IS NOT NULL)),
  CHECK (capability <> ''),
  CHECK (attempt_id IS NULL OR attempt_id <> ''),
  CHECK (owner_id IS NULL OR owner_id <> ''),
  CHECK (worker_instance_id IS NULL OR worker_instance_id <> ''),
  UNIQUE (account_id, intent_id),
  FOREIGN KEY (account_id, reservation_id)
    REFERENCES line_request_sequence_reservations(account_id, reservation_id)
);
CREATE INDEX line_mutation_intents_recovery_idx
  ON line_mutation_intents(state, updated_at)
  WHERE state IN ('ATTEMPT_RESERVED', 'IN_FLIGHT', 'UNKNOWN');
CREATE INDEX line_mutation_intents_account_chat_idx
  ON line_mutation_intents(account_id, chat_type, chat_id, prepared_at);

CREATE TABLE line_mutation_attempts (
  attempt_record_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  intent_id uuid NOT NULL,
  attempt_id text NOT NULL,
  owner_id text NOT NULL,
  worker_instance_id text NOT NULL,
  credential_version bigint NOT NULL CHECK (credential_version >= 0),
  reservation_id uuid NOT NULL,
  effect_permit_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('ATTEMPT_RESERVED', 'IN_FLIGHT', 'ABANDONED', 'SENT', 'REJECTED', 'UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, intent_id, attempt_id),
  UNIQUE (account_id, reservation_id),
  FOREIGN KEY (account_id, intent_id) REFERENCES line_mutation_intents(account_id, intent_id),
  FOREIGN KEY (account_id, reservation_id)
    REFERENCES line_request_sequence_reservations(account_id, reservation_id)
);
CREATE INDEX line_mutation_attempts_owner_idx
  ON line_mutation_attempts(account_id, owner_id, worker_instance_id, credential_version);

CREATE TABLE line_receive_cursors (
  account_id text PRIMARY KEY,
  owner_id text NOT NULL,
  transport_generation bigint NOT NULL CHECK (transport_generation >= 0),
  cursor jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_inbox_batches (
  batch_record_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  owner_id text NOT NULL,
  transport_generation bigint NOT NULL CHECK (transport_generation >= 0),
  batch_id text NOT NULL,
  batch_digest text NOT NULL CHECK (batch_digest ~ '^[0-9a-f]{64}$'),
  cursor_before jsonb NOT NULL,
  cursor_after jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, owner_id, transport_generation, batch_id),
  UNIQUE (account_id, batch_record_id)
);

CREATE TABLE line_inbox_events (
  inbox_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  source_event_id text NOT NULL,
  batch_record_id bigint NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  event_order bigint NOT NULL CHECK (event_order >= 0),
  raw jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source_event_id),
  UNIQUE (account_id, inbox_event_id),
  UNIQUE (account_id, source_event_id, inbox_event_id),
  FOREIGN KEY (account_id, batch_record_id) REFERENCES line_inbox_batches(account_id, batch_record_id)
);

CREATE TABLE line_sync_gaps (
  gap_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  owner_id text NOT NULL,
  transport_generation bigint NOT NULL CHECK (transport_generation >= 0),
  source_id text NOT NULL,
  kind text NOT NULL,
  details jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  UNIQUE (account_id, gap_id)
);
CREATE UNIQUE INDEX line_sync_gaps_source_idx
  ON line_sync_gaps(account_id, owner_id, transport_generation, source_id);
CREATE INDEX line_sync_gaps_recovery_idx ON line_sync_gaps(account_id, created_at) WHERE status = 'OPEN';

CREATE TABLE line_dispatch_outbox (
  dispatch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('direct', 'group', 'room')),
  chat_id text NOT NULL,
  source_event_id text NOT NULL,
  dispatch_kind text NOT NULL,
  retry_class text NOT NULL DEFAULT 'LOCAL_IDEMPOTENT' CHECK (retry_class = 'LOCAL_IDEMPOTENT'),
  payload jsonb NOT NULL,
  inbox_event_id bigint NOT NULL,
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY', 'LEASED', 'DONE')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state = 'LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'LEASED' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'DONE') = (completed_at IS NOT NULL)),
  UNIQUE (account_id, source_event_id, dispatch_kind),
  FOREIGN KEY (account_id, inbox_event_id) REFERENCES line_inbox_events(account_id, inbox_event_id),
  FOREIGN KEY (account_id, source_event_id, inbox_event_id)
    REFERENCES line_inbox_events(account_id, source_event_id, inbox_event_id)
);
CREATE INDEX line_dispatch_outbox_scan_idx
  ON line_dispatch_outbox(account_id, state, lease_until, dispatch_id);
CREATE INDEX line_dispatch_outbox_chat_order_idx
  ON line_dispatch_outbox(account_id, chat_type, chat_id, dispatch_id)
  WHERE state <> 'DONE';
