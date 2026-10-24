import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalAuditFallback } from './operational-audit-fallback.js';
import type { AuditEvent } from './operational-audit.js';

describe('operational audit JSONL fallback', () => {
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

  it('stores and reads structured events without changing their safe shape', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'operational-audit-')); folders.push(folder);
    const fallback = new OperationalAuditFallback(folder);
    const event: AuditEvent = { action: 'secret_clear', phase: 'succeeded', initiator: 'user', correlationId: 'request-1',
      accountId: 'account-a', resultCode: 'secret_removed', createdAt: '2026-10-17T10:00:00.000Z',
      diagnostic: { operation: 'secret_store', stage: 'write', category: 'persistence_failed', recovery: 'check_configuration' } };
    await fallback.append({ ...event, token: 'must-not-be-stored' } as never);
    await expect(fallback.list()).resolves.toEqual([event]);
    expect(JSON.parse((await readFile(join(folder, 'operational-current.jsonl'), 'utf8')).trim())).toEqual(event);
  });

  it('rotates a full current file and removes files older than fourteen days', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'operational-audit-')); folders.push(folder);
    const oldPath = join(folder, 'operational-expired.jsonl');
    await writeFile(oldPath, '{}\n');
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, oldDate, oldDate);
    const fallback = new OperationalAuditFallback(folder);
    await fallback.list();
    expect(await readdir(folder)).toEqual([]);

    const currentPath = join(folder, 'operational-current.jsonl');
    await writeFile(currentPath, 'x'.repeat(10 * 1024 * 1024));
    const event: AuditEvent = { action: 'worker_stop', phase: 'requested', initiator: 'system', correlationId: 'stop-1',
      createdAt: '2026-10-17T10:00:00.000Z' };
    await fallback.append(event);
    expect((await readdir(folder)).filter((name) => name.startsWith('operational-')).length).toBe(2);
    await expect(fallback.list()).resolves.toContainEqual(event);
  });

  it('survives initial cleanup failure and recovers when the fallback directory becomes available', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'operational-audit-')); folders.push(parent);
    const blockedPath = join(parent, 'blocked');
    await writeFile(blockedPath, 'not a directory');
    const fallback = new OperationalAuditFallback(blockedPath);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await rm(blockedPath);
    await mkdir(blockedPath);
    const event: AuditEvent = { action: 'secret_clear', phase: 'succeeded', initiator: 'user', correlationId: 'clear-retry',
      createdAt: '2026-10-17T10:00:00.000Z' };

    await expect(fallback.append(event)).resolves.toBeUndefined();
    await expect(fallback.list()).resolves.toContainEqual(event);
  });

  it('strictly reads eligible recent files, skips partial lines, and reports missing storage as empty', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'operational-audit-')); folders.push(parent);
    const missing = new OperationalAuditFallback(join(parent, 'missing'));
    await expect(missing.listStrict()).resolves.toEqual([]);
    const folder = await mkdtemp(join(tmpdir(), 'operational-audit-')); folders.push(folder);
    const event: AuditEvent = { action: 'worker_exited', phase: 'failed', initiator: 'worker', correlationId: 'private-id',
      errorCode: 'WORKER_STOP_FAILED', createdAt: '2026-10-17T10:00:00.000Z' };
    await writeFile(join(folder, 'operational-current.jsonl'), `${JSON.stringify(event)}\n{"phase":`);
    await writeFile(join(folder, 'unrelated.jsonl'), `${JSON.stringify({ ...event, correlationId: 'ignore-me' })}\n`);
    const fallback = new OperationalAuditFallback(folder);
    await expect(fallback.listStrict()).resolves.toEqual([event]);
  });
});
