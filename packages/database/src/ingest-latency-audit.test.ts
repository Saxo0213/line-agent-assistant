import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './test-database.js';
import { AuditRepository } from './audit-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('ingest latency audit records (migration 074)', () => {
  it('stores and returns the fixed numeric latency object and rejects anything else', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repository = new AuditRepository(pool);
      const latency = { lineToMainMs: 21_000, mainIngestMs: 40, queueLength: 2, messageCount: 1, reemitCount: 3 };
      await repository.append({ action: 'line_ingest_slow_upstream', phase: 'observed', initiator: 'worker',
        correlationId: 'latency-1', accountId: 'account-a', latency, createdAt: new Date().toISOString() });
      await repository.append({ action: 'line_ingest_slow_main', phase: 'observed', initiator: 'worker',
        correlationId: 'latency-2', latency: { ...latency, mainIngestMs: 5_000 }, createdAt: new Date().toISOString() });
      const rows = await repository.list(10);
      expect(rows.find((row) => row.correlationId === 'latency-1')).toMatchObject({ action: 'line_ingest_slow_upstream', latency });
      expect(rows.find((row) => row.correlationId === 'latency-2')?.latency?.mainIngestMs).toBe(5_000);
      const insert = (details: string) => pool.query("INSERT INTO audit_logs(action, actor, details) VALUES ('line_ingest_slow_main', 'worker', $1::jsonb)", [details]);
      const base = { phase: 'observed', correlation_id: 'bad' };
      await expect(insert(JSON.stringify({ ...base, latency: { ...latency, text: 'hello' } }))).rejects.toThrow();
      await expect(insert(JSON.stringify({ ...base, latency: { ...latency, queueLength: 'x' } }))).rejects.toThrow();
      await expect(insert(JSON.stringify({ ...base, latency: { ...latency, queueLength: -1 } }))).rejects.toThrow();
      await expect(insert(JSON.stringify({ ...base, latency: { lineToMainMs: 1 } }))).rejects.toThrow();
    } finally { await close(); }
  });
});
