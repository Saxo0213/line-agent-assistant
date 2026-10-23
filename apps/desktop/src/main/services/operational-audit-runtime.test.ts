import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createOperationalAuditRuntime } from './operational-audit-runtime.js';

describe('operational audit read sources', () => {
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

  it('merges DB and strict fallback records, deduplicates by audit identity, and reports partial availability', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'audit-runtime-')); folders.push(folder);
    const shared = { action: 'worker_exited', phase: 'failed', initiator: 'system', correlationId: 'private-id',
      errorCode: 'WORKER_STOP_FAILED', createdAt: '2026-10-17T10:00:00.000Z' };
    const fileOnly = { ...shared, correlationId: 'fallback-only', createdAt: '2026-10-17T10:01:00.000Z' };
    await writeFile(join(folder, 'operational-current.jsonl'), `${JSON.stringify(shared)}\n${JSON.stringify(fileOnly)}\n`);
    const pool = { async connect() { return { async query(sql: string) {
      if (sql.startsWith('SELECT action, actor, details')) return { rows: [{ action: shared.action, actor: shared.initiator,
        details: { phase: shared.phase, correlation_id: shared.correlationId, error_code: shared.errorCode }, created_at: new Date(shared.createdAt) }] };
      return { rows: [] };
    }, release() {} }; } } as unknown as Pool;
    const runtime = createOperationalAuditRuntime(pool, folder);

    await expect(runtime.listEvents(500)).resolves.toEqual({
      events: [
        { ...shared, initiator: 'system', correlationId: 'fallback-only', createdAt: fileOnly.createdAt },
        { ...shared, initiator: 'system' },
      ], available: true, partial: false,
    });
  });

  it('retains fallback audit failures when database acquisition is unavailable', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'audit-runtime-')); folders.push(folder);
    const event = { action: 'line_login_failed', phase: 'failed', initiator: 'user', correlationId: 'login-failed',
      errorCode: 'AGENT_AUTH_FAILED', createdAt: '2026-10-17T10:00:00.000Z' };
    await writeFile(join(folder, 'operational-current.jsonl'), `${JSON.stringify(event)}\n`);
    const pool = { async connect() { throw new Error('database unavailable'); } } as unknown as Pool;
    const runtime = createOperationalAuditRuntime(pool, folder);
    const result = await runtime.listEvents(500);
    expect(result.events).toEqual([event]);
    expect(result).toMatchObject({ available: true, partial: true });
  });

  it('reports the audit source unavailable when both bounded readers fail', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'audit-runtime-')); folders.push(folder);
    const filePath = join(folder, 'not-a-directory');
    await writeFile(filePath, 'block fallback directory');
    const pool = { async connect() { throw new Error('database unavailable'); } } as unknown as Pool;
    const result = await createOperationalAuditRuntime(pool, filePath).listEvents(500);
    expect(result).toEqual({ events: [], available: false, partial: true });
  });
});
