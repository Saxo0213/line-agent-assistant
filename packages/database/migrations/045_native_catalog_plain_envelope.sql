ALTER TABLE native_source_catalog_records
  DROP CONSTRAINT IF EXISTS native_source_catalog_records_check;

ALTER TABLE native_source_catalog_records
  ADD CONSTRAINT native_source_catalog_records_payload_check CHECK (
    (
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
    ) OR (
      jsonb_typeof(native_payload) = 'object'
      AND native_payload ?& ARRAY['format', 'table', 'sourceDigest', 'encoding', 'row']
      AND native_payload - ARRAY['format', 'table', 'sourceDigest', 'encoding', 'row']::text[] = '{}'::jsonb
      AND jsonb_typeof(native_payload->'format') = 'number'
      AND native_payload->'format' = '2'::jsonb
      AND jsonb_typeof(native_payload->'table') = 'string'
      AND native_payload->>'table' = table_name
      AND jsonb_typeof(native_payload->'sourceDigest') = 'string'
      AND native_payload->>'sourceDigest' = source_digest
      AND jsonb_typeof(native_payload->'encoding') = 'string'
      AND native_payload->>'encoding' = 'plain'
      AND jsonb_typeof(native_payload->'row') = 'object'
      AND native_payload->'row' ?& ARRAY['columns', 'cells']
      AND (native_payload->'row') - ARRAY['columns', 'cells']::text[] = '{}'::jsonb
      AND CASE
        WHEN jsonb_typeof(native_payload->'row'->'columns') = 'array'
          AND jsonb_typeof(native_payload->'row'->'cells') = 'array'
        THEN jsonb_array_length(native_payload->'row'->'columns') = jsonb_array_length(native_payload->'row'->'cells')
          AND jsonb_array_length(native_payload->'row'->'columns') <= 128
          AND jsonb_array_length(native_payload->'row'->'cells') <= 128
        ELSE false
      END
    )
  );

COMMENT ON TABLE native_source_catalog_records IS
  'Native LINE source catalog rows scoped to an external source generation; envelopes may contain protected or plain rows.';
