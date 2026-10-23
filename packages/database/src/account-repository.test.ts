import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AccountRepository', () => {
  let pool: Pool;
  let close: () => Promise<void>;

  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close?.(); });

  it('bounds resolveCapabilities when line_accounts is locked by another transaction', async () => {
    const accountId = 'resolve-capabilities-timeout';
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    const blocker: PoolClient = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE line_accounts IN ACCESS EXCLUSIVE MODE');
      const startedAt = Date.now();
      await expect(accounts.resolveCapabilities(accountId)).rejects.toMatchObject({ code: '57014' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(3_500);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});
