// Read-only extraction of server-format fields of live messages for `official-snapshot.mjs correlate`.
// Consent (2026-10-20): local, read-only, aggregate output only. Rows with raw.native (official-DB imports) and
// non-live rows are excluded. Only the listed raw fields leave the database. Nothing is written or logged.
export const PER_TYPE_LIMIT = 500;
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_ROWS = 100_000;

export const LIVE_ROWS_SQL = `
WITH base AS (
  SELECT message_id, kind, occurred_at, COALESCE(raw -> 'message', raw) AS m
  FROM messages
  WHERE ingestion_source = 'live' AND NOT (raw ? 'native') AND jsonb_typeof(COALESCE(raw -> 'message', raw)) = 'object'
), ranked AS (
  SELECT message_id, kind, occurred_at, m,
    row_number() OVER (PARTITION BY COALESCE(m ->> 'contentType', '') ORDER BY occurred_at DESC, message_id DESC) AS rn
  FROM base
)
SELECT message_id, kind, jsonb_strip_nulls(jsonb_build_object(
  'contentType', m -> 'contentType', 'contentMetadata', m -> 'contentMetadata', 'location', m -> 'location',
  'relatedMessageId', m -> 'relatedMessageId', 'messageRelationType', m -> 'messageRelationType',
  'reactions', m -> 'reactions', 'eventInfo', m -> 'eventInfo')) AS fields
FROM ranked WHERE rn <= $1
ORDER BY occurred_at DESC, message_id DESC
LIMIT $2`;

// `client` is a connected pg Client/PoolClient. Returns NDJSON lines (each ends with \n) plus counters.
export async function fetchLiveRows(client, options = {}) {
  const perType = Math.min(options.perType ?? PER_TYPE_LIMIT, PER_TYPE_LIMIT);
  const maxLine = options.maxLineBytes ?? MAX_LINE_BYTES;
  const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxRows = Math.min(options.maxRows ?? MAX_ROWS, MAX_ROWS);
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await client.query(LIVE_ROWS_SQL, [perType, maxRows]);
    const lines = [];
    let total = 0;
    let dropped = 0;
    let truncated = false;
    for (const row of result.rows) {
      const line = `${JSON.stringify({ messageId: row.message_id, kind: row.kind, fields: row.fields })}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > maxLine) { dropped += 1; continue; }
      if (total + bytes > maxTotal) { truncated = true; break; }
      total += bytes;
      lines.push(line);
    }
    return { lines, dropped, truncated };
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* the connection is closed by the caller */ }
  }
}
