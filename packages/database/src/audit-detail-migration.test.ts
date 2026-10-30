import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LINE_SERVER_ERROR_CODES } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Migration 081: the audit trigger takes a bounded diagnostic detail and every audit error code, including the LINE server codes.
database('audit_logs trigger: diagnostic detail and LINE server codes (real database)', () => {
  const diagnostic = { operation: 'sendMedia', stage: 'write', category: 'transport_failed', recovery: 'retry' };
  const insert = (pool: { query: (sql: string, values: unknown[]) => Promise<unknown> }, details: Record<string, unknown>) =>
    pool.query('INSERT INTO audit_logs(action,actor,details) VALUES ($1,$2,$3::jsonb)',
      ['worker_operation_error', 'system', JSON.stringify({ phase: 'observed', correlation_id: randomUUID(), ...details })]);

  it('accepts a safe detail and refuses a space, an over-long value, an empty value and a non-string', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      for (const detail of ['UPLOAD_FAILED:obs_upload:ObsHttpError:403', 'gateway:stale_binding', 'a'.repeat(160), 'x']) {
        await expect(insert(pool, { diagnostic: { ...diagnostic, detail } }), detail).resolves.toBeTruthy();
      }
      for (const detail of ['has space', 'a'.repeat(161), '', 7, null, true, ['a'], { a: 1 }, '/etc/passwd', 'line\nbreak']) {
        await expect(insert(pool, { diagnostic: { ...diagnostic, detail } }), JSON.stringify(detail)).rejects.toThrow();
      }
      // Any other free key is still refused.
      await expect(insert(pool, { diagnostic: { ...diagnostic, message: 'x' } })).rejects.toThrow();
    } finally { await close(); }
  });

  it('accepts every LINE server code and still refuses an unknown or malformed code', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      for (const code of LINE_SERVER_ERROR_CODES) await expect(insert(pool, { error_code: code }), code).resolves.toBeTruthy();
      await expect(insert(pool, { error_code: 'MESSAGE_SEND_FAILED' })).resolves.toBeTruthy();
      for (const code of ['LINE_TALK_NOT_A_REAL_NAME', 'LINE_TALK_', 'line_talk_abuse_block', 'UPLOAD_FAILED', 'LINE_RELATION_ADD_X', '']) {
        await expect(insert(pool, { error_code: code }), code).rejects.toThrow();
      }
    } finally { await close(); }
  });
});
