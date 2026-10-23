CREATE TABLE native_source_catalog_records (
  account_id text NOT NULL,
  source_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  table_name text NOT NULL CHECK (table_name IN (
    '_chat', '_chatOption', '_contact', '_profile', '_profileMappedId', '_groupChat', '_room', '_square',
    '_squareChat', '_squareMember', '_squareThread', '_squareBot', '_buddyDetail', '_buddyStatusBar',
    '_message_sticker', '_stickerProductNew', '_sticker_history', '_sticonProduct', '_sticon_mapping'
  )),
  record_key text NOT NULL CHECK (record_key <> ''),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  native_payload jsonb NOT NULL CHECK (
    jsonb_typeof(native_payload) = 'object'
    AND native_payload ?& ARRAY['format', 'table', 'sourceDigest', 'encoding', 'data']
    AND native_payload - ARRAY['format', 'table', 'sourceDigest', 'encoding', 'data']::text[] = '{}'::jsonb
    AND jsonb_typeof(native_payload->'format') = 'number'
    AND native_payload->'format' = '1'::jsonb
    AND jsonb_typeof(native_payload->'table') = 'string'
    AND native_payload->>'table' = table_name
    AND jsonb_typeof(native_payload->'sourceDigest') = 'string'
    AND native_payload->>'sourceDigest' = source_digest
    AND jsonb_typeof(native_payload->'encoding') = 'string'
    AND native_payload->>'encoding' = 'dpapi'
    AND jsonb_typeof(native_payload->'data') = 'string'
    AND length(native_payload->>'data') >= 4
    AND length(native_payload->>'data') % 4 = 0
    AND (native_payload->>'data') ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, generation, table_name, record_key),
  FOREIGN KEY (account_id, source_id, generation)
    REFERENCES line_account_sources(account_id, source_id, generation) ON DELETE CASCADE
);

COMMENT ON TABLE native_source_catalog_records IS
  'DPAPI-protected native LINE source catalog rows scoped to an external source generation.';
