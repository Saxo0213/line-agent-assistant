import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createTestDatabase } from './test-database.js';

const migrationName = '034_external_monitor_attachment_provenance_lookup.sql';
const indexName = 'message_source_provenance_external_attachment_idx';

describe('external attachment provenance recovery index', () => {
  it('adds the partial lookup index idempotently and uses it for exact provenance lookups', async () => {
    const sourceDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const migrationDirectory = await mkdtemp(join(tmpdir(), 'linejs-provenance-index-'));
    let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    try {
      for (const name of await readdir(sourceDirectory)) {
        if (name !== migrationName && /^\d+_.*\.sql$/.test(name)) {
          await copyFile(join(sourceDirectory, name), join(migrationDirectory, name));
        }
      }
      database = await createTestDatabase(migrationDirectory);
      const pool = database.pool;
      const accountId = `provenance-index-${randomUUID()}`;
      const chatId = `chat-${randomUUID()}`;
      const sourceId = randomUUID();
      await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
      await pool.query('INSERT INTO conversations(account_id, chat_id, chat_type) VALUES ($1,$2,\'group\')', [accountId, chatId]);
      await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw)
        SELECT $1,'external-'||i,'event-'||i,'group',$2,'sender','file','live',now()-interval '1 hour','{}'::jsonb FROM generate_series(1,2000) i`, [accountId, chatId]);
      await pool.query(`INSERT INTO line_account_sources(source_id,account_id,source_type,generation,identity_digest,verified_account_mid)
        VALUES ($1,$2,'EXTERNAL_MONITOR',1,repeat('a',64),'fixture-mid')`, [sourceId, accountId]);
      await pool.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
        VALUES ($1,$2,1,'fixture-batch',repeat('b',64),'{}'::jsonb)`, [sourceId, accountId]);
      await pool.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
        SELECT $1,$2,1,'obs-'||i,'fixture-batch','external-'||i,repeat('c',64),'{}'::jsonb,'PROJECTED' FROM generate_series(1,2000) i`, [sourceId, accountId]);
      await pool.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
        SELECT $1,'external-'||i,$2,1,'obs-'||i,'EXTERNAL_MONITOR',true FROM generate_series(1,2000) i`, [accountId, sourceId]);

      const baselineIndex = await pool.query<{ indexdef: string }>(
        'SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 AND indexname=$2',
        ['message_source_provenance', indexName]);
      expect(baselineIndex.rows).toHaveLength(0);
      const baselineRows = await pool.query<{ count: string }>('SELECT count(*) FROM message_source_provenance');
      expect(baselineRows.rows[0]?.count).toBe('2000');

      await migrate(pool);
      const installed = await pool.query<{ indexdef: string }>(
        'SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 AND indexname=$2',
        ['message_source_provenance', indexName]);
      expect(installed.rows).toHaveLength(1);
      const definition = installed.rows[0]!.indexdef.toLowerCase().replace(/"/g, '');
      expect(definition).toContain('using btree (account_id, message_id)');
      expect(definition).toContain("where (origin = 'external_monitor'::text)");

      await migrate(pool);
      const replayRows = await pool.query<{ count: string }>('SELECT count(*) FROM message_source_provenance');
      expect(replayRows.rows[0]?.count).toBe(baselineRows.rows[0]?.count);
      await pool.query('ANALYZE message_source_provenance');
      const plan = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT 1 FROM message_source_provenance p WHERE p.account_id=$1 AND p.message_id=$2
          AND p.origin='EXTERNAL_MONITOR' LIMIT 1`, [accountId, 'external-1999']);
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(indexName);
      const lookup = await pool.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM message_source_provenance p
        WHERE p.account_id=$1 AND p.message_id=$2 AND p.origin='EXTERNAL_MONITOR') AS present`, [accountId, 'external-1999']);
      expect(lookup.rows[0]?.present).toBe(true);
    } finally {
      if (database) await database.close();
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });
});
