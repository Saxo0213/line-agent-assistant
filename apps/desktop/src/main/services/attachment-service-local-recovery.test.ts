import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageRepository } from '@line-agent/database';
import { AttachmentService } from './attachment-service.js';
import type { BridgeAttachmentStore } from './official-download-bridge/bridge-attachment-store.js';

const BYTES = Buffer.from('local recovery test bytes');

function row(overrides: Record<string, unknown> = {}) {
  return { attachmentId: 'att-1', externalAttachmentId: 'ext-1', accountId: 'admin', chatType: 'group' as const, chatId: 'g',
    messageId: 'm1', kind: 'file' as const, name: 'report.pdf', mimeType: null, status: 'expired' as const, relativePath: null,
    sha256: null, sizeBytes: BYTES.length, error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE', occurredAt: new Date().toISOString(),
    retryCount: 0, retryAfter: null, createdAt: new Date().toISOString(), expiresAt: null, lineMessage: {}, nativeEnvelope: null,
    externalSource: true, ...overrides };
}

describe('AttachmentService recoverFromLocalDownloads', () => {
  let downloads: string;
  let root: string;
  let marked: Array<Record<string, unknown>>;

  beforeEach(async () => {
    downloads = await mkdtemp(join(tmpdir(), 'dl-'));
    root = await mkdtemp(join(tmpdir(), 'root-'));
    marked = [];
  });
  afterEach(async () => {
    await rm(downloads, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  // A fake store that writes into the temp root, as the managed store does.
  const store: BridgeAttachmentStore = async (input) => {
    const chunks: Buffer[] = [];
    for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    const relativePath = `stored/${input.name}`;
    await mkdir(join(root, 'stored'), { recursive: true });
    await writeFile(join(root, 'stored', input.name), data);
    return { relativePath, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.length, name: input.name };
  };

  function service(attachment: ReturnType<typeof row>): AttachmentService {
    const repository = { async getAttachment() { return attachment; }, async revokeAttachmentOwner() {},
      async markAttachmentRecoveredFromLocal(input: Record<string, unknown>) { marked.push(input); return true; },
    } as unknown as MessageRepository;
    return new AttachmentService(repository, { async binding() { return null; }, async isReady() { return false; },
      async download() { throw new Error('no network'); } } as never, root, 4, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, { downloadsDir: downloads, store });
  }

  it('recovers a file with the exact name and size', async () => {
    await writeFile(join(downloads, 'report.pdf'), BYTES);
    const target = service(row());
    try {
      await expect(target.recoverFromLocalDownloads('att-1')).resolves.toBe('recovered');
      expect(marked).toHaveLength(1);
      expect(marked[0]).toMatchObject({ attachmentId: 'att-1', relativePath: 'stored/report.pdf', sizeBytes: BYTES.length,
        sha256: createHash('sha256').update(BYTES).digest('hex') });
      expect(await readFile(join(downloads, 'report.pdf'))).toEqual(BYTES);
    } finally { await target.shutdown(); }
  });

  it('recovers a duplicate name and treats the name case-insensitively on Windows', async () => {
    await writeFile(join(downloads, process.platform === 'win32' ? 'REPORT (1).PDF' : 'report (1).pdf'), BYTES);
    const target = service(row());
    try {
      await expect(target.recoverFromLocalDownloads('att-1')).resolves.toBe('recovered');
    } finally { await target.shutdown(); }
  });

  it('does not accept a file with another size', async () => {
    await writeFile(join(downloads, 'report.pdf'), Buffer.concat([BYTES, Buffer.from('x')]));
    const target = service(row());
    try {
      await expect(target.recoverFromLocalDownloads('att-1')).resolves.toBe('not_found');
      expect(marked).toHaveLength(0);
      await expect(stat(join(root, 'stored'))).rejects.toThrow();
    } finally { await target.shutdown(); }
  });

  it('does not accept a symbolic link', async (context) => {
    const real = join(downloads, 'real.bin');
    await writeFile(real, BYTES);
    try { await symlink(real, join(downloads, 'report.pdf')); } catch { context.skip(); return; }
    const target = service(row());
    try {
      await expect(target.recoverFromLocalDownloads('att-1')).resolves.toBe('not_found');
    } finally { await target.shutdown(); }
  });

  it('returns not_eligible for a ready row and for an unsafe name', async () => {
    await writeFile(join(downloads, 'report.pdf'), BYTES);
    const ready = service(row({ status: 'ready' as const }));
    const unsafe = service(row({ name: '..\\report.pdf' }));
    try {
      await expect(ready.recoverFromLocalDownloads('att-1')).resolves.toBe('not_eligible');
      await expect(unsafe.recoverFromLocalDownloads('att-1')).resolves.toBe('not_eligible');
      expect(marked).toHaveLength(0);
    } finally { await ready.shutdown(); await unsafe.shutdown(); }
  });

  it('downloadManually returns true after a local recovery without a worker call', async () => {
    await writeFile(join(downloads, 'report.pdf'), BYTES);
    const target = service(row());
    try {
      await expect(target.downloadManually({ accountId: 'admin', chatType: 'group', chatId: 'g' }, 'att-1')).resolves.toBe(true);
      expect(marked).toHaveLength(1);
    } finally { await target.shutdown(); }
  });
});
