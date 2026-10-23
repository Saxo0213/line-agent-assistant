import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchLiveRows, type LiveRowsQueryClient } from '../../../../../../scripts/official-snapshot-live-rows.mjs';

// A14: the runner's live-row query, run only against the throwaway demo PostgreSQL (port 55433) in a private schema.
// The runner's bootstrap path (production DPAPI URL) is never executed here; the connection is injected.
const DEMO_URL = 'postgresql://line_agent_demo:line_agent_demo_only@127.0.0.1:55433/line_agent_demo';
const schema = `test_runner_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let pool: Pool;
let reachable = false;

function insert(id: string, source: string, occurred: string, raw: unknown): Promise<unknown> {
  return pool.query('INSERT INTO messages(message_id, kind, occurred_at, raw, ingestion_source) VALUES ($1, $2, $3, $4, $5)',
    [id, 'text', occurred, JSON.stringify(raw), source]);
}

async function withClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await run(client); } finally { client.release(); }
}

describe('official snapshot runner live-row query (demo database only)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: DEMO_URL, max: 1 });
    try { await admin.query('SELECT 1'); reachable = true; } catch { reachable = false; }
    if (!reachable) return;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DEMO_URL, options: `-c search_path=${schema}`, max: 2 });
    await pool.query('CREATE TABLE messages(message_id text PRIMARY KEY, kind text, occurred_at timestamptz, raw jsonb, ingestion_source text, other_secret text)');
    const message = (id: string, contentType: unknown, extra: Record<string, unknown> = {}) => ({
      revision: 1, message: { id, from: 'SENTINEL-FROM', text: 'SENTINEL-TEXT', contentType, contentMetadata: { K: 'v' }, ...extra },
    });
    await insert('loc-1', 'live', '2026-01-01T00:00:01Z', message('loc-1', 15, { location: { title: 'T1', latitude: 1.5, longitude: 2.5 }, relatedMessageId: 'r1', messageRelationType: 3 }));
    await insert('loc-2', 'live', '2026-01-01T00:00:02Z', message('loc-2', 15, { location: { title: 'T2', latitude: 1.5, longitude: 2.5 } }));
    await insert('loc-3', 'live', '2026-01-01T00:00:03Z', message('loc-3', 15, { location: { title: 'T3' } }));
    await insert('txt-1', 'live', '2026-01-01T00:00:04Z', message('txt-1', 0));
    await insert('str-1', 'live', '2026-01-01T00:00:05Z', message('str-1', 'LOCATION'));
    await insert('flat-1', 'live', '2026-01-01T00:00:06Z', { id: 'flat-1', contentType: 13, contentMetadata: { mid: 'x' }, text: 'SENTINEL-FLAT' });
    await insert('native-1', 'live', '2026-01-01T00:00:07Z', { ...message('native-1', 15), native: { table: '_message' } });
    await insert('history-1', 'history', '2026-01-01T00:00:08Z', message('history-1', 15));
    await insert('huge-1', 'live', '2026-01-01T00:00:09Z', message('huge-1', 99, { contentMetadata: { pad: 'x'.repeat(70_000) } }));
  }, 60_000);
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin && reachable) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (admin) await admin.end();
  });

  it('is a READ ONLY transaction with a statement timeout, always rolled back', async () => {
    expect(reachable, 'demo database 55433 must be running').toBe(true);
    await withClient(async (client) => {
      const statements: string[] = [];
      let readOnlyDuringSelect = '';
      const spy: LiveRowsQueryClient = {
        async query(text, values) {
          statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
          if (text.includes('FROM messages')) readOnlyDuringSelect = String((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only);
          return client.query(text, values);
        },
      };
      await fetchLiveRows(spy);
      expect(statements[0]).toBe('BEGIN READ ONLY');
      expect(statements[1]).toBe('SET LOCAL statement_timeout');
      expect(statements.at(-1)).toBe('ROLLBACK');
      expect(readOnlyDuringSelect).toBe('on');
      // A write inside the same transaction is rejected by the database itself.
      await client.query('BEGIN READ ONLY');
      await expect(client.query("INSERT INTO messages(message_id, kind, raw, ingestion_source) VALUES ('w', 'text', '{}', 'live')")).rejects.toThrow(/read-only/);
      await client.query('ROLLBACK');
    });
  });

  it('keeps only live rows without raw.native, exposes only the listed raw fields, and caps rows per content type', async () => {
    const result = await withClient((client) => fetchLiveRows(client, { perType: 2 }));
    const rows = result.lines.map((line) => JSON.parse(line) as { messageId: string; kind: string; fields: Record<string, unknown> });
    const ids = rows.map((row) => row.messageId).sort();
    expect(ids).toEqual(['flat-1', 'loc-2', 'loc-3', 'str-1', 'txt-1']);
    expect(result.dropped).toBe(1); // the >64 KiB line is dropped, not truncated
    const text = result.lines.join('');
    expect(text).not.toContain('SENTINEL');
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['messageId', 'kind', 'fields']);
      for (const key of Object.keys(row.fields)) expect(['contentType', 'contentMetadata', 'location', 'relatedMessageId', 'messageRelationType', 'reactions', 'eventInfo']).toContain(key);
    }
    const loc2 = rows.find((row) => row.messageId === 'loc-2')!;
    expect(loc2.fields).toEqual({ contentType: 15, contentMetadata: { K: 'v' }, location: { title: 'T2', latitude: 1.5, longitude: 2.5 } });
    expect(result.lines.every((line) => line.endsWith('\n') && Buffer.byteLength(line) <= 64 * 1024)).toBe(true);
  });

  it('respects the per-type default of 500 and the total byte cap', async () => {
    const all = await withClient((client) => fetchLiveRows(client));
    expect(all.lines.length).toBe(6); // loc-1..3, txt-1, str-1, flat-1; native, history and the oversize row never appear
    expect(all.truncated).toBe(false);
    const capped = await withClient((client) => fetchLiveRows(client, { maxTotalBytes: 400 }));
    expect(capped.truncated).toBe(true);
    expect(capped.lines.join('').length).toBeLessThanOrEqual(400);
    const limited = await withClient((client) => fetchLiveRows(client, { maxRows: 2 }));
    expect(limited.lines.length).toBeLessThanOrEqual(2);
  });
});
