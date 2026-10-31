import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';

describe('account worker invalidation fence', () => {
  it('atomically marks reauth and clears only the matching worker binding', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const accounts = new AccountRepository({ query } as never);

    await expect(accounts.invalidateWorkerBinding({ accountId: 'a', workerInstanceId: 'worker-old', controlEpoch: 7 }))
      .resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(expect.stringMatching(/UPDATE line_accounts SET status='reauth_required',[\s\S]*worker_instance_id=NULL,[\s\S]*worker_binding_epoch=NULL[\s\S]*WHERE account_id=\$1 AND worker_instance_id=\$2 AND worker_binding_epoch=\$3/),
      ['a', 'worker-old', 7]);
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(accounts.invalidateWorkerBinding({ accountId: 'a', workerInstanceId: 'worker-old', controlEpoch: 7 }))
      .resolves.toBe(false);
  });

  it('writes only the sync time for the exact worker binding and reports whether one row changed', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const accounts = new AccountRepository({ query } as never);

    await expect(accounts.applyWorkerSyncConfirmed({ accountId: 'a', workerInstanceId: 'worker-1', controlEpoch: 7 })).resolves.toBe(true);
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('SET last_synced_at=now(), updated_at=now()');
    expect(sql).not.toMatch(/status\s*=/);
    expect(sql).toContain("WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$3 AND mode <> 'PAUSED'");
    expect(query.mock.calls[0]![1]).toEqual(['a', 'worker-1', 7]);
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(accounts.applyWorkerSyncConfirmed({ accountId: 'a', workerInstanceId: 'worker-1', controlEpoch: 7 })).resolves.toBe(false);
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('verified own MID storage', () => {
  let pool: Pool; let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close?.(); });
  it('persists own MID for self-message and mention routing', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('a');
    await accounts.setOwnMid('a', 'u-agent');
    expect(await accounts.getAccount('a')).toMatchObject({ accountId: 'a', ownMid: 'u-agent' });
  });

  it('does not invalidate a replacement binding and clears the matching binding atomically', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('fenced-invalidation');
    const { controlEpoch } = await accounts.getControlState();
    const old = { accountId: 'fenced-invalidation', workerInstanceId: 'old-worker', controlEpoch };
    const replacement = { accountId: 'fenced-invalidation', workerInstanceId: 'new-worker', controlEpoch };
    await accounts.bindWorker(old);

    await expect(accounts.invalidateWorkerBinding(old)).resolves.toBe(true);
    expect((await pool.query("SELECT status,worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id='fenced-invalidation'")).rows[0])
      .toEqual({ status: 'reauth_required', worker_instance_id: null, worker_binding_epoch: null });

    await accounts.bindWorker(replacement);
    await expect(accounts.invalidateWorkerBinding(old)).resolves.toBe(false);
    expect((await pool.query("SELECT status,worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id='fenced-invalidation'")).rows[0])
      .toEqual({ status: 'reauth_required', worker_instance_id: 'new-worker', worker_binding_epoch: String(controlEpoch) });
  });

  it('refreshes last_synced_at without changing status and refuses a stale binding or a PAUSED account', async () => {
    const accounts = new AccountRepository(pool);
    const binding = { accountId: 'sync-confirmed', workerInstanceId: 'sync-worker', controlEpoch: 1 };
    await accounts.ensureAccount(binding.accountId);
    await accounts.bindWorker(binding);
    await pool.query("UPDATE line_accounts SET status='degraded', last_synced_at='2020-01-01T00:00:00Z' WHERE account_id=$1", [binding.accountId]);
    const read = async () => (await pool.query('SELECT status, last_synced_at FROM line_accounts WHERE account_id=$1', [binding.accountId])).rows[0];

    await expect(accounts.applyWorkerSyncConfirmed(binding)).resolves.toBe(true);
    const after = await read();
    expect(after.status).toBe('degraded');
    expect(new Date(after.last_synced_at).getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());

    await pool.query("UPDATE line_accounts SET last_synced_at='2020-01-01T00:00:00Z' WHERE account_id=$1", [binding.accountId]);
    await expect(accounts.applyWorkerSyncConfirmed({ ...binding, workerInstanceId: 'other-worker' })).resolves.toBe(false);
    await expect(accounts.applyWorkerSyncConfirmed({ ...binding, controlEpoch: 2 })).resolves.toBe(false);
    expect(new Date((await read()).last_synced_at).toISOString()).toBe('2020-01-01T00:00:00.000Z');

    await pool.query("UPDATE line_accounts SET mode='PAUSED' WHERE account_id=$1", [binding.accountId]);
    await expect(accounts.applyWorkerSyncConfirmed(binding)).resolves.toBe(false);
    expect(new Date((await read()).last_synced_at).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('leaves reauth_required final when a health write is held before or attempted after the fence', async () => {
    const accounts = new AccountRepository(pool);
    const beforeFence = { accountId: 'health-before-fence', workerInstanceId: 'health-worker-before', controlEpoch: 1 };
    const afterFence = { accountId: 'health-after-fence', workerInstanceId: 'health-worker-after', controlEpoch: 1 };
    await accounts.ensureAccount(beforeFence.accountId);
    await accounts.ensureAccount(afterFence.accountId);
    await accounts.bindWorker(beforeFence);
    await accounts.bindWorker(afterFence);

    const heldHealthWrite = await pool.connect();
    try {
      await heldHealthWrite.query('BEGIN');
      await heldHealthWrite.query("UPDATE line_accounts SET status='degraded' WHERE account_id=$1", [beforeFence.accountId]);
      const invalidation = accounts.invalidateWorkerBinding(beforeFence);
      await heldHealthWrite.query('COMMIT');
      await expect(invalidation).resolves.toBe(true);
    } finally {
      await heldHealthWrite.query('ROLLBACK').catch(() => undefined);
      heldHealthWrite.release();
    }

    await expect(accounts.invalidateWorkerBinding(afterFence)).resolves.toBe(true);
    await expect(accounts.applyWorkerConnectionStatus(afterFence, 'degraded')).resolves.toBe(false);
    const finalRows = await pool.query("SELECT status,worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id = ANY($1::text[]) ORDER BY account_id",
      [[beforeFence.accountId, afterFence.accountId]]);
    expect(finalRows.rows).toEqual([
      { status: 'reauth_required', worker_instance_id: null, worker_binding_epoch: null },
      { status: 'reauth_required', worker_instance_id: null, worker_binding_epoch: null },
    ]);
  });
});
