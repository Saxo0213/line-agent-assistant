import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import { createTestDatabase } from './test-database.js';
import {
  BOUNDED_TRANSACTION_MARGIN_MS, BoundedTransactionTimeoutError, withBoundedTransaction, type BoundedPoolClient,
} from './bounded-transaction.js';

type Phase = 'BEGIN' | 'SET' | 'BODY' | 'COMMIT' | 'ROLLBACK';
const BODY_SQL = 'SELECT 1 AS body';
const phaseOf = (text: string): Phase | null => text === 'BEGIN' ? 'BEGIN' : text.startsWith('SET LOCAL statement_timeout') ? 'SET'
  : text === BODY_SQL ? 'BODY' : text === 'COMMIT' ? 'COMMIT' : text === 'ROLLBACK' ? 'ROLLBACK' : null;

/** Fake client whose query for the stalled phase never settles and ignores query_timeout, so only the helper deadline can end it. */
function fakeClient(stall: Phase | null) {
  const calls: Array<{ text: string; queryTimeout: number | undefined }> = [];
  const release = vi.fn<(err?: Error | boolean) => void>();
  const client: BoundedPoolClient = {
    query: (config: QueryConfig) => {
      const queryTimeout = (config as QueryConfig & { query_timeout?: number }).query_timeout;
      calls.push({ text: config.text, queryTimeout });
      if (phaseOf(config.text) === stall) return new Promise<QueryResult>(() => undefined);
      return Promise.resolve({ rows: [{ body: 1 }], rowCount: 1 } as unknown as QueryResult);
    },
    release,
  };
  return { client, calls, release };
}

describe('withBoundedTransaction (fake pool)', () => {
  afterEach(() => { vi.useRealTimers(); });

  const TIMEOUT_MS = 2000;
  const DEADLINE_MS = TIMEOUT_MS + BOUNDED_TRANSACTION_MARGIN_MS;

  it('runs BEGIN, SET LOCAL statement_timeout first, the body, then COMMIT, each with the remaining deadline as query_timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = fakeClient(null);
    const result = await withBoundedTransaction({ connect: async () => fake.client }, async (tx) => (await tx.query(BODY_SQL)).rows[0]);
    expect(result).toEqual({ body: 1 });
    expect(fake.calls.map((call) => call.text)).toEqual(['BEGIN', "SET LOCAL statement_timeout = '2000ms'", BODY_SQL, 'COMMIT']);
    for (const call of fake.calls) expect(call.queryTimeout).toBe(DEADLINE_MS);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rolls back, destroys the connection and rethrows when the body fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = fakeClient(null);
    const failure = new Error('body failed');
    await expect(withBoundedTransaction({ connect: async () => fake.client }, async () => { throw failure; })).rejects.toBe(failure);
    expect(fake.calls.map((call) => call.text)).toEqual(['BEGIN', "SET LOCAL statement_timeout = '2000ms'", 'ROLLBACK']);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledWith(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['BEGIN', 'SET', 'BODY', 'COMMIT', 'ROLLBACK'] as const)('a stalled %s rejects within the deadline and destroys the client once', async (phase) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = fakeClient(phase);
    const bodyFailure = new Error('body failed');
    let settled = false;
    const run = withBoundedTransaction({ connect: async () => fake.client }, async (tx) => {
      await tx.query(BODY_SQL);
      // The ROLLBACK case needs a failing body to reach ROLLBACK.
      if (phase === 'ROLLBACK') throw bodyFailure;
      return 'ok';
    }, { timeoutMs: TIMEOUT_MS });
    void run.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(settled).toBe(false);
    expect(fake.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    if (phase === 'ROLLBACK') await expect(run).rejects.toBe(bodyFailure);
    else await expect(run).rejects.toBeInstanceOf(BoundedTransactionTimeoutError);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.release.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(fake.calls.some((call) => phaseOf(call.text) === phase)).toBe(true);
    // No ROLLBACK is attempted once the deadline has passed (cleanup shares the same deadline).
    if (phase !== 'ROLLBACK') expect(fake.calls.filter((call) => call.text === 'ROLLBACK')).toHaveLength(0);
    for (const call of fake.calls) expect(call.queryTimeout).toBeGreaterThan(0);
    for (const call of fake.calls) expect(call.queryTimeout).toBeLessThanOrEqual(DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('attempts a bounded ROLLBACK with the remaining time after a failure and keeps the original error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = fakeClient(null);
    const failure = new Error('late failure');
    const run = withBoundedTransaction({ connect: async () => fake.client }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_400));
      throw failure;
    });
    const assertion = expect(run).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(2_400);
    await assertion;
    expect(fake.calls.at(-1)).toEqual({ text: 'ROLLBACK', queryTimeout: DEADLINE_MS - 2_400 });
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects in time when acquisition stalls and releases the late client on arrival', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = fakeClient(null);
    let deliver!: (client: BoundedPoolClient) => void;
    const connect = vi.fn(() => new Promise<BoundedPoolClient>((resolve) => { deliver = resolve; }));
    const body = vi.fn(async () => 'never');
    let settled = false;
    const run = withBoundedTransaction({ connect }, body);
    void run.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).rejects.toBeInstanceOf(BoundedTransactionTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
    deliver(fake.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.release.mock.calls[0]![0]).toBeInstanceOf(BoundedTransactionTimeoutError);
    expect(fake.calls).toHaveLength(0);
    expect(body).not.toHaveBeenCalled();
  });

  it('rejects a failed acquisition without touching any client', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const failure = new Error('pool is closed');
    await expect(withBoundedTransaction({ connect: async () => { throw failure; } }, async () => 1)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses queries issued after the transaction finished', async () => {
    const fake = fakeClient(null);
    let leaked!: { query: (text: string) => Promise<unknown> };
    await withBoundedTransaction({ connect: async () => fake.client }, async (tx) => { leaked = tx; });
    await expect(leaked.query(BODY_SQL)).rejects.toThrow(/no longer active/);
    expect(fake.calls.map((call) => call.text)).not.toContain(BODY_SQL);
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('withBoundedTransaction (PostgreSQL)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    await pool.query('CREATE TABLE bounded_probe (id integer PRIMARY KEY)');
    await pool.query('INSERT INTO bounded_probe VALUES (1)');
  });
  afterAll(async () => { await close?.(); });

  it('a table lock gives a bounded rejection, rolls back, and destroys the connection', async () => {
    const removed = vi.fn();
    const released = vi.fn();
    pool.on('remove', removed);
    pool.on('release', released);
    const blocker: PoolClient = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE bounded_probe IN ACCESS EXCLUSIVE MODE');
      // No idle client remains, so the helper opens a fresh connection and must destroy it.
      expect(pool.idleCount).toBe(0);
      const totalBefore = pool.totalCount;
      const startedAt = Date.now();
      await expect(withBoundedTransaction(pool, async (tx) => tx.query('SELECT id FROM bounded_probe'), { timeoutMs: 500 }))
        .rejects.toMatchObject({ code: '57014' });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(500 + BOUNDED_TRANSACTION_MARGIN_MS);
      // The helper's connection was released with the error and left the pool; only the blocker remains checked out.
      expect(released).toHaveBeenCalledTimes(1);
      expect(released.mock.calls[0]![0]).toMatchObject({ code: '57014' });
      expect(pool.totalCount).toBe(totalBefore);
      expect(pool.idleCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      pool.off('release', released);
    }
    // 'remove' fires once the destroyed connection's socket has ended.
    await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    pool.off('remove', removed);
    expect(pool.totalCount).toBe(pool.idleCount);
    expect(pool.waitingCount).toBe(0);
    // The pool is healthy afterwards and the server timeout did not leak into a reused session.
    expect((await pool.query<{ timeout: string }>('SHOW statement_timeout')).rows[0]!.timeout).not.toBe('500ms');
    expect((await withBoundedTransaction(pool, async (tx) => (await tx.query<{ id: number }>('SELECT id FROM bounded_probe')).rows)))
      .toEqual([{ id: 1 }]);
  }, 15_000);

  it('the application deadline (pg query_timeout) ends a statement the server timeout does not cover', async () => {
    const totalBefore = pool.totalCount;
    const startedAt = Date.now();
    await expect(withBoundedTransaction(pool, async (tx) => {
      await tx.query('SET LOCAL statement_timeout = 0');
      await tx.query('SELECT pg_sleep(3)');
    }, { timeoutMs: 300 })).rejects.toThrow(/timeout|deadline/i);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_200);
    expect(elapsed).toBeLessThan(2_500);
    expect(pool.totalCount).toBeLessThanOrEqual(totalBefore);
    expect(pool.totalCount).toBe(pool.idleCount);
  }, 15_000);
});
