import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { ExternalMonitorRepository } from './external-monitor-repository.js';

function createClient(query: (sql: string, ...args: unknown[]) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 })) {
  const client = { query: vi.fn((sql: string, ...args: unknown[]) => query(sql, ...args)), release: vi.fn() } as unknown as PoolClient;
  return client;
}

function createRepository(client: PoolClient | Promise<PoolClient>) {
  return new ExternalMonitorRepository({ connect: () => Promise.resolve(client) } as unknown as Pool);
}

const transactionOperations = [
  ['checkpoint fence read', (repo: ExternalMonitorRepository, signal: AbortSignal) => repo.readBatchFence({
    accountId: 'account', sourceId: 'source-id', generation: 1, signal,
  })],
  ['checkpoint state read', (repo: ExternalMonitorRepository, signal: AbortSignal) => repo.getInitialImportState({
    accountId: 'account', sourceId: 'source-id', generation: 1, signal,
  })],
  ['source bind', (repo: ExternalMonitorRepository, signal: AbortSignal) => repo.bindVerifiedExternalSource({
    accountId: 'account', ownMid: 'mid', sourceIdentity: 'source', signal,
  })],
  ['unfinished reset', (repo: ExternalMonitorRepository, signal: AbortSignal) => repo.resetUnfinishedInitialImport({
    accountId: 'account', sourceId: 'source-id', generation: 1, expectedModeRevision: 1, expectedCheckpoint: {},
    sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), schemaVersion: 'v1', highWater: null, eligibleCount: '0', signal,
  })],
  ['final completion', (repo: ExternalMonitorRepository, signal: AbortSignal) => repo.completeInitialImport({
    accountId: 'account', sourceId: 'source-id', generation: 1, expectedModeRevision: 1, expectedCheckpoint: {},
    finalCursor: {}, highWater: null, signal,
  })],
  ['page projection', (repo: ExternalMonitorRepository, signal: AbortSignal) => repo.stageAndProjectBatch({
    accountId: 'account', sourceId: 'source-id', generation: 1, expectedModeRevision: 1, expectedCheckpoint: {},
    batchId: 'page', cursor: {}, initialImport: true, observations: [], signal,
  })],
] as const;

describe('external import database operation ownership', () => {
  it('runs final completion without elapsed or SQL deadlines while preserving abort cleanup', async () => {
    vi.useFakeTimers();
    try {
      let pendingStarted!: () => void;
      let releasePending!: (value: unknown) => void;
      const pendingQueryStarted = new Promise<void>((resolve) => { pendingStarted = resolve; });
      const heldPendingQuery = new Promise<unknown>((resolve) => { releasePending = resolve; });
      const sql: string[] = [];
      const client = createClient(async (statement) => {
        sql.push(statement);
        if (statement.startsWith('SELECT a.mode_revision,s.state')) return { rows: [{ mode_revision: '1', state: 'ACTIVE',
          connection_mode: 'EXTERNAL_MONITOR', transition_state: 'STABLE', own_mid: 'mid', verified_account_mid: 'mid',
          admin_binding_mid: 'mid', current_admin_mid: 'mid', admin_binding_version: '1', current_admin_version: '1',
          product_role: 'PRIMARY_ADMIN', agent_role: 'AGENT', read_capability: true }], rowCount: 1 };
        if (statement.startsWith('SELECT c.cursor,c.high_water')) return { rows: [{ cursor: {}, high_water: null,
          initial_import_complete: false, eligible_count: '0', committed_count: '0' }], rowCount: 1 };
        if (statement.startsWith('SELECT 1 FROM external_source_observations')) { pendingStarted(); return heldPendingQuery; }
        return { rows: [], rowCount: 1 };
      });
      const repository = createRepository(client);
      const controller = new AbortController();
      const operation = repository.completeInitialImport({ accountId: 'account', sourceId: 'source-id', generation: 1,
        expectedModeRevision: 1, expectedCheckpoint: {}, finalCursor: {}, highWater: null, signal: controller.signal });
      await pendingQueryStarted;

      expect(sql.some((statement) => statement.includes("status IN ('STAGED','CONFLICT')"))).toBe(true);
      expect(sql).toContain('SET LOCAL statement_timeout = 0');
      expect(sql).toContain("SET LOCAL lock_timeout = '4000ms'");
      expect(vi.getTimerCount()).toBe(0);
      controller.abort();
      await expect(operation).rejects.toThrow('cancelled');
      expect(client.release).toHaveBeenCalledWith(true);
      releasePending({ rows: [], rowCount: 0 });
      await Promise.resolve();
      expect(sql.at(-1)?.startsWith('SELECT 1 FROM external_source_observations')).toBe(true);
      expect(sql).not.toContain('COMMIT');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(transactionOperations)('cancels %s during a stalled database query and destroys its client', async (_name, run) => {
    let entered!: () => void;
    let releaseQuery!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<unknown>((resolve) => { releaseQuery = resolve; });
    const sql: string[] = [];
    const client = createClient(async (statement) => {
      sql.push(statement);
      if (statement.startsWith('SELECT')) { entered(); return held; }
      return { rows: [], rowCount: 0 };
    });
    const originalQuery = client.query;
    const repository = createRepository(client);
    const controller = new AbortController();
    const operation = run(repository, controller.signal);
    await started;
    controller.abort();
    await expect(operation).rejects.toThrow('cancelled');
    expect(client.release).toHaveBeenCalledWith(true);
    releaseQuery({ rows: [], rowCount: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.query).toBe(originalQuery);
    expect(sql.at(-1)?.startsWith('SELECT')).toBe(true);
    expect(sql).not.toContain('COMMIT');
  });

  it('destroys a client that arrives after database acquisition was cancelled', async () => {
    let acquire!: (client: PoolClient) => void;
    const client = createClient();
    const repository = createRepository(new Promise<PoolClient>((resolve) => { acquire = resolve; }));
    const controller = new AbortController();
    const operation = repository.readBatchFence({ accountId: 'account', sourceId: 'source-id', generation: 1, signal: controller.signal });
    controller.abort();
    await expect(operation).rejects.toThrow('cancelled');
    acquire(client);
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledTimes(1));
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('cleans up admission and timeout ownership when pool acquisition throws synchronously', async () => {
    vi.useFakeTimers();
    try {
      const repository = new ExternalMonitorRepository({ connect: () => { throw new Error('pool is closed'); } } as unknown as Pool);
      for (let index = 0; index < 4; index += 1) {
        await expect(repository.readBatchFence({ accountId: 'account', sourceId: 'source-id', generation: 1 }))
          .rejects.toThrow('pool is closed');
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a client when database transport stalls past the operation deadline', async () => {
    vi.useFakeTimers();
    try {
      let entered!: () => void;
      const queryStarted = new Promise<void>((resolve) => { entered = resolve; });
      const client = createClient(async () => { entered(); return new Promise<never>(() => undefined); });
      const repository = createRepository(client);
      const operation = repository.readBatchFence({ accountId: 'account', sourceId: 'source-id', generation: 1 });
      const rejected = expect(operation).rejects.toThrow('deadline exceeded');
      await queryStarted;
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys the client when rollback transport also fails', async () => {
    const client = createClient(async (sql) => {
      if (sql.startsWith('SELECT a.own_mid')) throw new Error('database transport failed');
      if (sql === 'ROLLBACK') throw new Error('rollback transport failed');
      return { rows: [], rowCount: 0 };
    });
    const repository = createRepository(client);
    await expect(repository.bindVerifiedExternalSource({ accountId: 'account', ownMid: 'mid', sourceIdentity: 'source' }))
      .rejects.toThrow('requires a configured Primary Admin account');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('reuses an unmodified pooled query method across successful reads', async () => {
    const row = { mode_revision: '1', cursor: {}, own_mid: 'mid', verified_account_mid: 'mid', source_state: 'ACTIVE',
      product_role: 'PRIMARY_ADMIN', transition_state: 'STABLE', connection_mode: 'EXTERNAL_MONITOR',
      admin_binding_account_id: 'agent', admin_binding_mid: 'mid', admin_binding_version: '1', agent_role: 'AGENT',
      current_admin_mid: 'mid', current_admin_version: '1' };
    const client = createClient(async () => ({ rows: [row], rowCount: 1 }));
    const originalQuery = client.query;
    const repository = createRepository(client);
    for (let index = 0; index < 20; index += 1) {
      const controller = new AbortController();
      await repository.readBatchFence({ accountId: 'account', sourceId: 'source-id', generation: 1, signal: controller.signal });
      expect(client.query).toBe(originalQuery);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      controller.abort();
    }
    expect(client.release).toHaveBeenCalledTimes(20);
    expect(client.release).toHaveBeenLastCalledWith(false);
  });

  it('reuses the same pooled client after a failed page and across successful pages', async () => {
    const authority = { own_mid: 'mid', verified_account_mid: 'mid', identity_digest: 'a'.repeat(64), state: 'ACTIVE',
      product_role: 'PRIMARY_ADMIN', source_transition_state: 'STABLE', connection_mode: 'EXTERNAL_MONITOR', mode_revision: '1',
      admin_binding_account_id: 'agent', admin_binding_mid: 'mid', admin_binding_version: '1', agent_role: 'AGENT',
      current_admin_mid: 'mid', current_admin_version: '1' };
    let cursor: Record<string, unknown> = {};
    let failFirstAuthority = true;
    const client = createClient(async (sql, args) => {
      if (sql.startsWith('SELECT a.own_mid,s.verified_account_mid')) {
        if (failFirstAuthority) { failFirstAuthority = false; return { rows: [], rowCount: 0 }; }
        return { rows: [authority], rowCount: 1 };
      }
      if (sql.startsWith('SELECT payload_digest,result')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT account_id,generation,cursor')) return { rows: [{ account_id: 'account', generation: '1', cursor }], rowCount: 1 };
      if (sql.startsWith('SELECT initial_import_complete')) return { rows: [{ initial_import_complete: false }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO external_source_checkpoints')) cursor = JSON.parse(String(args[3])) as Record<string, unknown>;
      return { rows: [], rowCount: 1 };
    });
    const originalQuery = client.query;
    const repository = createRepository(client);
    const page = (batchId: string, previous: Record<string, unknown>, next: Record<string, unknown>) => repository.stageAndProjectBatch({
      accountId: 'account', sourceId: 'source-id', generation: 1, expectedModeRevision: 1, expectedCheckpoint: previous,
      batchId, cursor: next, initialImport: true, observations: [],
    });
    await expect(page('failed', {}, { id: 'one' })).rejects.toThrow();
    expect(client.query).toBe(originalQuery);
    await page('first', {}, { id: 'one' });
    expect(client.query).toBe(originalQuery);
    await page('second', { id: 'one' }, { id: 'two' });
    expect(client.query).toBe(originalQuery);
    expect(client.release).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenLastCalledWith(false);
  });
});
