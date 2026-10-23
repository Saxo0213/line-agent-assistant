import { describe, expect, it, vi } from 'vitest';
import { createTestDatabase } from './test-database.js';
import { AuditRepository } from './audit-repository.js';

it('keeps at most one audit connection waiter per shared pool during sustained exhaustion', async () => {
  vi.useFakeTimers();
  try {
    let connectCalls = 0;
    const pool = { connect() { connectCalls += 1; return new Promise(() => {}); } } as never;
    const repository = new AuditRepository(pool);
    const event = { action: 'secret_clear', phase: 'requested', initiator: 'user', correlationId: 'clear-1', createdAt: new Date().toISOString() } as const;
    const first = repository.append(event).catch((error: unknown) => error);
    const attempts = Array.from({ length: 20 }, () => repository.append(event).catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(2000);
    expect(String(await first)).toContain('AUDIT_DB_TIMEOUT');
    const errors = await Promise.all(attempts);
    expect(errors.every((error) => String(error).includes('AUDIT_DB_BUSY'))).toBe(true);
    expect(connectCalls).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('destroys a late audit read client once and keeps its drain fence until acquisition settles', async () => {
  vi.useFakeTimers();
  try {
    let finishConnect!: (client: { query: () => Promise<{ rows: never[] }>; release: (destroy?: boolean) => void }) => void;
    const release = vi.fn();
    const pool = { connect: () => new Promise<{ query: () => Promise<{ rows: never[] }>; release: (destroy?: boolean) => void }>((resolve) => { finishConnect = resolve; }) } as never;
    const repository = new AuditRepository(pool);
    const result = repository.list().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(String(await result)).toContain('AUDIT_READ_TIMEOUT');
    let drained = false;
    const drain = repository.waitForReadDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finishConnect({ query: async () => ({ rows: [] }), release });
    await drain;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('keeps a timed out audit query fenced until it settles and destroys its client once', async () => {
  vi.useFakeTimers();
  try {
    let finishQuery!: (value: { rows: never[] }) => void;
    let queryCount = 0;
    const release = vi.fn();
    const pool = { async connect() { return { query(sql: string) {
      queryCount += 1;
      return sql.startsWith('SELECT') ? new Promise<{ rows: never[] }>((resolve) => { finishQuery = resolve; }) : Promise.resolve({ rows: [] });
    }, release }; } } as never;
    const repository = new AuditRepository(pool);
    const result = repository.list().catch((error: unknown) => error);
    for (let attempt = 0; attempt < 10 && queryCount < 3; attempt += 1) await Promise.resolve();
    expect(queryCount).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(String(await result)).toContain('AUDIT_READ_TIMEOUT');
    let drained = false;
    const drain = repository.waitForReadDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finishQuery({ rows: [] });
    await drain;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AuditRepository', () => {
  it('stores only allowlisted details, reads events, and rejects row mutation', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const repository = new AuditRepository(pool);
      await repository.append({ action: 'secret_clear', phase: 'succeeded', initiator: 'user', correlationId: 'request-a',
        accountId: 'account-a', requestId: 'request-a', resultCode: 'secret_removed', createdAt: '2026-10-17T10:00:00.000Z',
        token: 'must-not-persist' } as never);

      const rows = await pool.query<{ action: string; details: Record<string, unknown> }>(
        "SELECT action,details FROM audit_logs WHERE action='secret_clear'");
      expect(rows.rows[0]).toEqual({ action: 'secret_clear', details: {
        correlation_id: 'request-a', phase: 'succeeded', account_id: 'account-a', request_id: 'request-a', result_code: 'secret_removed',
      } });
      expect(await repository.list()).toMatchObject([{ action: 'secret_clear', phase: 'succeeded', accountId: 'account-a',
        requestId: 'request-a', resultCode: 'secret_removed' }]);
      await expect(pool.query("UPDATE audit_logs SET action='changed' WHERE action='secret_clear'")).rejects.toThrow('append-only');
      await expect(pool.query("DELETE FROM audit_logs WHERE action='secret_clear'")).rejects.toThrow('append-only');
    } finally { await close(); }
  });

  it('rejects details with fields outside the operational audit schema', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      await expect(pool.query("INSERT INTO audit_logs(action,actor,details) VALUES ('secret_clear','user','{\"phase\":\"requested\",\"correlation_id\":\"invalid-fields\",\"token\":\"private\"}')"))
        .rejects.toThrow('unsupported fields');
    } finally { await close(); }
  });
});
