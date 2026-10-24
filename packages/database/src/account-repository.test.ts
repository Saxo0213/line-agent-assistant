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

  it('refreshes only the connected account profile under its current worker and identity binding', async () => {
    const accountId = 'avatar-refresh-binding';
    const ownMid = `u${'a'.repeat(32)}`;
    const binding = { accountId, workerInstanceId: 'avatar-worker-current', controlEpoch: 1 };
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId, 'Before refresh');
    await pool.query(`UPDATE line_accounts SET own_mid=$2,product_role='AGENT',worker_instance_id=$3,
      worker_binding_epoch=$4,status='connected',mode='MONITOR_ONLY' WHERE account_id=$1`,
    [accountId, ownMid, binding.workerInstanceId, binding.controlEpoch]);

    expect(await accounts.canRefreshWorkerAvatar(binding, ownMid)).toBe(true);
    expect(await accounts.refreshWorkerAvatar(binding, ownMid, 'After refresh', 'https://profile.line-scdn.net/new.png')).toBe(true);
    expect(await accounts.getAccount(accountId)).toMatchObject({ accountId, ownMid });
    expect((await pool.query('SELECT display_name,picture_path FROM line_accounts WHERE account_id=$1', [accountId])).rows[0])
      .toEqual({ display_name: 'After refresh', picture_path: 'https://profile.line-scdn.net/new.png' });

    expect(await accounts.canRefreshWorkerAvatar({ ...binding, workerInstanceId: 'stale-worker' }, ownMid)).toBe(false);
    expect(await accounts.refreshWorkerAvatar(binding, `u${'b'.repeat(32)}`, 'Wrong identity', null)).toBe(false);
    await pool.query("UPDATE line_accounts SET mode='PAUSED' WHERE account_id=$1", [accountId]);
    expect(await accounts.canRefreshWorkerAvatar(binding, ownMid)).toBe(false);
  });
});
