import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageRepository } from '@line-agent/database';
import { AttachmentService, type ExternalBridgeDownloads } from './attachment-service.js';
import type { BridgeDownloadRequest } from './official-download-bridge/bridge-download.js';

function row(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return { attachmentId: 'att-1', externalAttachmentId: 'ext-1', accountId: 'admin', chatType: 'group' as const, chatId: 'g',
    messageId: 'm1', kind: 'file' as const, name: 'report.pdf', mimeType: null, status: 'queued' as const, relativePath: null,
    sha256: null, sizeBytes: 5, error: null, occurredAt: now, retryCount: 0, retryAfter: null, createdAt: now, updatedAt: now,
    expiresAt: null, lineMessage: {}, nativeEnvelope: null, externalSource: true, ...overrides };
}

describe('AttachmentService live download of a new External Monitor message', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  function build(overrides: Record<string, unknown> = {}, result = 'match') {
    const requests: BridgeDownloadRequest[] = [];
    const gapKinds: string[] = [];
    const attachment = row(overrides);
    const repository = { async getAttachment() { return attachment; }, async revokeAttachmentOwner() {},
      async claimExternalAttachmentForBridge() { return true; }, async markExternalAttachmentReadyByBridge() { return true; },
      async markExternalAttachmentFailedByBridge() { return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async nextAttachmentWakeAt() { return null; },
    } as unknown as MessageRepository;
    const bridge: ExternalBridgeDownloads = {
      downloader: { isLive: () => true, verify: async () => ({ result, detail: result }) as never,
        run: (async (request: BridgeDownloadRequest) => { requests.push(request); return { relativePath: 'stored/a', sha256: 'a'.repeat(64), sizeBytes: 5, name: 'report.pdf' }; }) as never },
      store: (async () => { throw new Error('unused'); }) as never,
      isAutoDownloadEnabled: () => true, isDownloadEnabled: () => true, isIdentityVerified: () => true, recordVerification: () => undefined,
      downloadGapMs: (kind) => { gapKinds.push(kind); return 7_000; },
    };
    const service = new AttachmentService(repository, { async binding() { return null; }, async isReady() { return false; },
      async download() { throw new Error('no worker'); } } as never, undefined, 4, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, bridge);
    return { service, requests, gapKinds, nextAt: () => (service as unknown as { nextAutomaticAt: number }).nextAutomaticAt,
      setNextAt: (value: number) => { (service as unknown as { nextAutomaticAt: number }).nextAutomaticAt = value; } };
  }

  it('starts at once and ignores a pending automatic gap and the durable due time', async () => {
    const h = build();
    h.setNextAt(Date.now() + 60_000);
    try {
      await h.service.verifyNewExternalAttachment('att-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toMatchObject({ kind: 'file', source: 'store', live: true });
    } finally { await h.service.shutdown(); }
  });

  it('downloads with the store message after identity_match and gives the identity of an incomplete row to verify', async () => {
    const verifyRequests: Array<{ identity?: unknown }> = [];
    const attachment = row({ senderId: 'sender-1', nativeEnvelope: { format: 2, encoding: 'plain', table: '_message',
      row: { columns: ['_id', '_contentType'], cells: ['m1', 14] } } });
    const requests: BridgeDownloadRequest[] = [];
    const repository = { async getAttachment() { return attachment; }, async revokeAttachmentOwner() {},
      async claimExternalAttachmentForBridge() { return true; }, async markExternalAttachmentReadyByBridge() { return true; },
      async markExternalAttachmentFailedByBridge() { return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async nextAttachmentWakeAt() { return null; },
    } as unknown as MessageRepository;
    const bridge: ExternalBridgeDownloads = {
      downloader: { isLive: () => true,
        verify: (async (request: { identity?: unknown }) => { verifyRequests.push(request); return { result: 'identity_match', detail: 'identity_match' }; }) as never,
        run: (async (request: BridgeDownloadRequest) => { requests.push(request); return { relativePath: 'stored/a', sha256: 'a'.repeat(64), sizeBytes: 5, name: 'report.pdf' }; }) as never },
      store: (async () => { throw new Error('unused'); }) as never,
      isAutoDownloadEnabled: () => true, isDownloadEnabled: () => true, isIdentityVerified: () => true, recordVerification: () => undefined,
      downloadGapMs: () => 7_000,
    };
    const service = new AttachmentService(repository, { async binding() { return null; }, async isReady() { return false; },
      async download() { throw new Error('no worker'); } } as never, undefined, 4, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, bridge);
    try {
      await service.verifyNewExternalAttachment('att-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(verifyRequests[0]?.identity).toEqual({ chatType: 'group', kind: 'file' });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ kind: 'file', source: 'store', live: true });
    } finally { await service.shutdown(); }
  });

  it('sets the per-kind gap for the next download that is not live', async () => {
    const h = build();
    try {
      await h.service.verifyNewExternalAttachment('att-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.gapKinds).toEqual(['file']);
      expect(h.nextAt()).toBe(Date.now() + 7_000);
    } finally { await h.service.shutdown(); }
  });

  it('downloads a recovered row (2 days old) that is not live after a match, and does not after a mismatch', async () => {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const matched = build({ occurredAt: old, createdAt: old });
    try {
      await matched.service.verifyRecoveredExternalAttachment('att-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(matched.requests).toHaveLength(1);
      expect(matched.requests[0]).toMatchObject({ kind: 'file', source: 'store', live: false });
    } finally { await matched.service.shutdown(); }
    const mismatched = build({ occurredAt: old, createdAt: old }, 'mismatch');
    try {
      await mismatched.service.verifyRecoveredExternalAttachment('att-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(mismatched.requests).toHaveLength(0);
    } finally { await mismatched.service.shutdown(); }
  });
});

describe('AttachmentService worker download of an Agent account attachment', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  function build() {
    const attachment = row({ accountId: 'agent', externalSource: false, externalAttachmentId: 'oid-1' });
    const downloads: unknown[] = [];
    const repository = { async getAttachment() { return attachment; }, async revokeAttachmentOwner() {},
      async claimAttachmentDownload() { return 'token-1'; },
      async markAttachmentReady() { return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async nextAttachmentWakeAt() { return null; },
    } as unknown as MessageRepository;
    const binding = { accountId: 'agent', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const worker = { async binding() { return binding; }, async isReady() { return true; },
      async download(command: { requestId: string }) {
        downloads.push(command);
        return { status: 'ready' as const, attachmentId: 'att-1', attemptToken: 'token-1', workerInstanceId: 'w1', accountId: 'agent',
          chatType: 'group' as const, chatId: 'g', relativePath: 'a/b.pdf', sha256: 'a'.repeat(64), sizeBytes: 5, name: 'report.pdf' };
      } };
    const service = new AttachmentService(repository, worker as never);
    return { service, downloads };
  }

  it('downloads a live attachment at once and keeps the 10 s wait for any other source', async () => {
    const live = build();
    try {
      void live.service.downloadById('att-1', undefined, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(live.downloads).toHaveLength(1);
    } finally { await live.service.shutdown(); }
    const history = build();
    try {
      void history.service.downloadById('att-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(history.downloads).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(history.downloads).toHaveLength(1);
    } finally { await history.service.shutdown(); }
  });
});

describe('AttachmentService store of a file that this app sent', () => {
  function build(idsOfMessage: string[]) {
    const attachment = row({ attachmentId: 'att-1', accountId: 'agent', chatType: 'direct', chatId: 'u-peer', messageId: '900', kind: 'image', name: null,
      externalSource: false, externalAttachmentId: 'oid-1' });
    const marked: Array<Record<string, unknown>> = [];
    const stored: Array<{ name: string; bytes: number[] }> = [];
    const downloads: unknown[] = [];
    const repository = { async getAttachment() { return attachment; }, async revokeAttachmentOwner() {},
      async listAttachmentIdsByMessage() { return idsOfMessage; },
      async markAttachmentRecoveredFromLocal(input: Record<string, unknown>) { marked.push(input); return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async nextAttachmentWakeAt() { return null; },
    } as unknown as MessageRepository;
    const store = async (input: { name: string; source: AsyncIterable<Uint8Array> }) => {
      const chunks: number[] = [];
      for await (const chunk of input.source) chunks.push(...chunk);
      stored.push({ name: input.name, bytes: chunks });
      return { relativePath: 'agent/direct/photo.png', sha256: createHash('sha256').update(Uint8Array.from(chunks)).digest('hex'), sizeBytes: chunks.length, name: input.name };
    };
    const worker = { async binding() { return null; }, async isReady() { return false; }, async download() { downloads.push(1); throw new Error('no download'); } };
    const service = new AttachmentService(repository, worker as never, undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, { downloadsDir: 'unused', store: store as never });
    return { service, marked, stored, downloads };
  }
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sent = { accountId: 'agent', chatType: 'direct' as const, chatId: 'u-peer', messageId: '900', name: 'photo.png', bytes };

  it('stores the local bytes at once when the message row already exists, with no LINE download', async () => {
    const h = build(['att-1']);
    try {
      await expect(h.service.storeSentMedia(sent)).resolves.toBe(true);
      expect(h.stored).toEqual([{ name: 'photo.png', bytes: [1, 2, 3, 4] }]);
      expect(h.marked).toEqual([expect.objectContaining({ attachmentId: 'att-1', accountId: 'agent', relativePath: 'agent/direct/photo.png',
        sizeBytes: 4, name: 'photo.png', sha256: createHash('sha256').update(bytes).digest('hex') })]);
      expect(h.downloads).toHaveLength(0);
    } finally { await h.service.shutdown(); }
  });

  it('keeps the bytes until the message row arrives and then stores them instead of downloading', async () => {
    const h = build([]);
    try {
      await expect(h.service.storeSentMedia(sent)).resolves.toBe(false);
      expect(h.marked).toHaveLength(0);
      await expect(h.service.downloadById('att-1')).resolves.toBe(true);
      expect(h.marked).toHaveLength(1);
      expect(h.downloads).toHaveLength(0);
    } finally { await h.service.shutdown(); }
  });
});
