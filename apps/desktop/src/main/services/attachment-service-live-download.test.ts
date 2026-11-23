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
