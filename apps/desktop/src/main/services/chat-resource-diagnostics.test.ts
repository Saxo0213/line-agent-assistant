import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatResourceDiagnostics, parseChatResourceDiagnostic } from './chat-resource-diagnostics.js';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chat-diagnostics-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const validRecord = {
  source: 'modal', accountId: 'account-1', chatId: 'chat_1', action: 'note_list',
  occurredAt: '2026-10-23T09:00:00.000Z', durationMs: 45, status: 'success', itemCount: 2,
  byteCount: 512, responseFields: [{ name: 'id', type: 'string' }, { name: 'posts', type: 'array' }],
};

describe('chat resource diagnostics', () => {
  it('keeps only bounded typed fields and discards content and sensitive response names', () => {
    const record = parseChatResourceDiagnostic({ ...validRecord, correlationId: 'local-reference', noteText: 'private note', authorization: 'Bearer secret',
      responseFields: [...validRecord.responseFields, { name: 'accessToken', type: 'string' },
        { name: 'body', type: 'string' }, { name: 'profile', type: 'object' }] });
    expect(record).toMatchObject({ source: 'modal', status: 'success', itemCount: 2, correlationId: 'local-reference' });
    expect(record?.responseFields).toEqual([{ name: 'id', type: 'string' }, { name: 'posts', type: 'array' }, { name: 'profile', type: 'object' }]);
    expect(JSON.stringify(record)).not.toContain('private note');
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(parseChatResourceDiagnostic({ ...validRecord, errorCode: 'server says token=secret' })).toBeNull();
  });

  it('accepts mcp as a sanitized read source', () => {
    expect(parseChatResourceDiagnostic({ ...validRecord, source: 'mcp' })?.source).toBe('mcp');
  });

  it('preserves a bounded album identifier and automatic scan limit reason', () => {
    expect(parseChatResourceDiagnostic({ ...validRecord, source: 'notification', action: 'album_photos', albumId: 'album:one',
      status: 'failure', errorCode: 'RESPONSE_INVALID', failureStage: 'archive_scan', failureReason: 'page_limit' }))
      .toMatchObject({ albumId: 'album:one', failureStage: 'archive_scan', failureReason: 'page_limit' });
    expect(parseChatResourceDiagnostic({ ...validRecord, source: 'notification', action: 'album_photos', albumId: 'album:one',
      status: 'failure', errorCode: 'UNKNOWN', failureStage: 'archive_write', failureReason: 'photo_write_failed' }))
      .toMatchObject({ failureStage: 'archive_write', failureReason: 'photo_write_failed' });
    expect(parseChatResourceDiagnostic({ ...validRecord, source: 'notification', action: 'album_list',
      status: 'failure', errorCode: 'UNKNOWN', failureStage: 'archive_scan', failureReason: 'archive_incomplete' }))
      .toMatchObject({ failureStage: 'archive_scan', failureReason: 'archive_incomplete' });
    expect(parseChatResourceDiagnostic({ ...validRecord, source: 'notification', action: 'album_list',
      status: 'failure', errorCode: 'UNKNOWN', failureStage: 'archive_scan', failureReason: 'archive_reconciliation_failed' }))
      .toMatchObject({ failureStage: 'archive_scan', failureReason: 'archive_reconciliation_failed' });
    expect(parseChatResourceDiagnostic({ ...validRecord, source: 'notification', action: 'album_photos',
      status: 'failure', errorCode: 'UNKNOWN', failureStage: 'archive_contains', failureReason: 'unknown' }))
      .toMatchObject({ failureStage: 'archive_contains', failureReason: 'unknown' });
  });

  it('persists only allowlisted worker failure categories', () => {
    expect(parseChatResourceDiagnostic({ ...validRecord, status: 'failure', failureCategory: 'bootstrap_failure' })?.failureCategory)
      .toBe('bootstrap_failure');
    expect(parseChatResourceDiagnostic({ ...validRecord, failureCategory: 'server response token=secret' })).toBeNull();
  });

  it('writes bounded upstream album facts through the production parser and sink', async () => {
    const logger = createChatResourceDiagnostics({ appDataDirectory: await tempRoot() });
    logger.record({ ...validRecord, source: 'notification', action: 'album_list', status: 'failure',
      failureCategory: 'response_code_invalid', failureKind: 'linejs_internal', upstreamCode: 102001,
      responseFields: [] });
    await logger.shutdown();
    const lines = (await readFile(logger.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({ action: 'album_list', failureKind: 'linejs_internal', upstreamCode: 102001 }));
  });

  it('persists normalized upstream facts while rejecting invalid status and fractional code', async () => {
    const root = await tempRoot();
    const logger = createChatResourceDiagnostics({ appDataDirectory: root });
    const normalized = parseChatResourceDiagnostic({ ...validRecord, source: 'notification', action: 'album_list', status: 'failure',
      failureCategory: 'list_get_transport_failure', failureKind: 'linejs_internal', upstreamCode: 'non_numeric' });
    expect(normalized).not.toBeNull();
    logger.record(normalized!);
    expect(parseChatResourceDiagnostic({ ...validRecord, status: 'failure', upstreamStatus: 0 })).toBeNull();
    expect(parseChatResourceDiagnostic({ ...validRecord, status: 'failure', upstreamStatus: 799 })).toBeNull();
    expect(parseChatResourceDiagnostic({ ...validRecord, status: 'failure', upstreamCode: 1.5 })).toBeNull();
    await logger.shutdown();
    const lines = (await readFile(logger.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({ action: 'album_list', failureKind: 'linejs_internal', upstreamCode: 'non_numeric' }));
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('preserves bounded native failure kind, HTTP status, and LINE response code', () => {
    expect(parseChatResourceDiagnostic({ ...validRecord, action: 'album_list', status: 'failure',
      failureCategory: 'response_code_invalid', failureKind: 'linejs_internal', upstreamCode: 102001 }))
      .toMatchObject({ failureKind: 'linejs_internal', upstreamCode: 102001 });
    expect(parseChatResourceDiagnostic({ ...validRecord, action: 'album_list', status: 'failure',
      failureCategory: 'list_get_transport_failure', failureKind: 'linejs_internal', upstreamStatus: 503 }))
      .toMatchObject({ upstreamStatus: 503 });
    expect(parseChatResourceDiagnostic({ ...validRecord, action: 'album_list', status: 'failure', upstreamCode: 'private response' })).toBeNull();
    expect(parseChatResourceDiagnostic({ ...validRecord, action: 'album_list', upstreamStatus: 799 })).toBeNull();
    expect(parseChatResourceDiagnostic({ ...validRecord, status: 'success', failureKind: 'other' })).toBeNull();
  });

  it.each([[-1_000_000_000, -1_000_000_000], [1_000_000_000, 1_000_000_000], ['missing', 'missing'], ['non_numeric', 'non_numeric']] as const)
    ('accepts a bounded response code diagnostic (%s)', (_label, responseCode) => {
      expect(parseChatResourceDiagnostic({ ...validRecord, status: 'failure', failureCategory: 'response_code_invalid', responseCode }))
        .toMatchObject({ responseCode });
    });

  it.each([1_000_000_001, -1_000_000_001, Number.NaN, 'private response'])('rejects an unbounded response code diagnostic (%s)', (responseCode) => {
    expect(parseChatResourceDiagnostic({ ...validRecord, status: 'failure', failureCategory: 'response_code_invalid', responseCode })).toBeNull();
  });

  it('accepts response code only on a failed Note diagnostic', () => {
    expect(parseChatResourceDiagnostic({ ...validRecord, responseCode: 403 })).toBeNull();
    expect(parseChatResourceDiagnostic({ ...validRecord, action: 'album_list', status: 'failure', failureCategory: 'response_code_invalid', responseCode: 403 })).toBeNull();
  });

  it.each([1, 2])('keeps total files and bytes within retention when retainedFiles is %i', async (retainedFiles) => {
    const logger = createChatResourceDiagnostics({ appDataDirectory: await tempRoot(), maxFileBytes: 4096, retainedFiles });
    const path = logger.filePath;
    expect(isAbsolute(path)).toBe(true);
    for (let index = 0; index < 60; index += 1) {
      logger.record({ ...validRecord, source: index === 59 ? 'mcp' : 'modal', action: index === 59 ? 'album_list' : 'note_list', itemCount: index });
    }
    await logger.shutdown();
    expect(logger.filePath).toBe(path);
    const files = (await readdir(join(path, '..'))).filter((name) => name === 'chat-resource-diagnostics.jsonl' || /^chat-resource-diagnostics\.jsonl\.\d+$/.test(name));
    expect(files).toHaveLength(retainedFiles);
    const stats = await Promise.all(files.map((name) => stat(join(path, '..', name))));
    expect(stats.every((file) => file.size <= 4096)).toBe(true);
    expect(stats.reduce((total, file) => total + file.size, 0)).toBeLessThanOrEqual(4096 * retainedFiles);
    const rows = (await Promise.all(files.map((name) => readFile(join(path, '..', name), 'utf8')))).join('').trim().split('\n');
    expect(rows.some((row) => JSON.parse(row).source === 'mcp')).toBe(true);
  });

  it('skips an append when a required rotation cannot complete', async () => {
    const root = await tempRoot();
    const logger = createChatResourceDiagnostics({ appDataDirectory: root, maxFileBytes: 4096, retainedFiles: 2 });
    const nextRecord = { ...validRecord, itemCount: 100 };
    const lineBytes = Buffer.byteLength(JSON.stringify(parseChatResourceDiagnostic(nextRecord))) + 1;
    let size = 0;
    while (size + lineBytes <= 4096) {
      logger.record(validRecord);
      await new Promise((resolve) => setTimeout(resolve, 10));
      size = (await stat(logger.filePath)).size;
    }
    await mkdir(`${logger.filePath}.1`);
    await writeFile(join(`${logger.filePath}.1`, 'blocker'), 'keep rotation blocked');
    const fullLog = await readFile(logger.filePath, 'utf8');
    logger.record(nextRecord);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readFile(logger.filePath, 'utf8')).toBe(fullLog);
    await rm(`${logger.filePath}.1`, { recursive: true, force: true });
    logger.record(nextRecord);
    await logger.shutdown();
    expect(JSON.parse(await readFile(logger.filePath, 'utf8'))).toMatchObject({ itemCount: 100 });
  });

  it('strips unknown content and remains best effort after shutdown or write failure', async () => {
    const root = await tempRoot();
    const occupiedPath = join(root, 'not-a-directory');
    await writeFile(occupiedPath, 'occupied');
    const logger = createChatResourceDiagnostics({ appDataDirectory: occupiedPath, queueCapacity: 1, maxFileBytes: 4096 });
    expect(() => logger.record({ ...validRecord, extra: Buffer.alloc(100_000) })).not.toThrow();
    await logger.shutdown();
    expect(() => logger.record(validRecord)).not.toThrow();
  });
});
