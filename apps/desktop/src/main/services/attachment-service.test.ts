import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AttachmentResult, LineWorkerCommand } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, MessageRepository } from '../../../../../packages/database/src/index.js';
import type { Attachment } from '../../../../../packages/database/src/message-repository.js';
import { ATTACHMENT_GAP_MAX_MS, ATTACHMENT_GAP_MIN_MS, AttachmentService } from './attachment-service.js';

function queuedAttachment(id: string, createdAt = new Date(Date.now() - 11_000), overrides: Record<string, unknown> = {}) {
  return { attachmentId: id, externalAttachmentId: `external-${id}`, accountId: 'a', chatType: 'group' as const,
    chatId: 'g', messageId: `message-${id}`, kind: 'file' as const, name: `${id}.bin`, mimeType: null,
    status: 'queued' as const, relativePath: null, sha256: null, sizeBytes: null, error: null,
    occurredAt: new Date(Date.now() - 60_000).toISOString(), retryCount: 0, retryAfter: null,
    createdAt: createdAt.toISOString(), expiresAt: null, lineMessage: {}, ...overrides };
}

// Tests that exercise queue order rather than pacing remove the random gap.
function withoutGap(service: AttachmentService): void {
  (service as unknown as { randomGapMs(): number }).randomGapMs = () => 0;
}

function readyAttachmentResult(command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>) {
  return { type: 'attachmentResult' as const, accountId: command.accountId, chatType: command.chatType,
    chatId: command.chatId, workerInstanceId: command.workerInstanceId, attachmentId: command.attachmentId,
    attemptToken: command.attemptToken, status: 'ready' as const, relativePath: `managed/${command.attachmentId}.bin`,
    sha256: 'a'.repeat(64), sizeBytes: 1, name: 'ready.bin' };
}

describe('AttachmentService queued automatic downloads', () => {
  it('persists the attachment phase code and forwards the trusted Talk result once for audit', async () => {
    const row = queuedAttachment('talk-token-rejection');
    const saved: string[] = [];
    const observed: AttachmentResult[] = [];
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { return randomUUID(); },
      async markAttachmentFailed(_attempt: unknown, code: string) { saved.push(code); row.status = 'failed' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const download = vi.fn(async (command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>) => ({
      type: 'attachmentResult' as const, status: 'failed' as const, accountId: command.accountId,
      chatType: command.chatType, chatId: command.chatId, attachmentId: command.attachmentId,
      attemptToken: command.attemptToken, workerInstanceId: command.workerInstanceId,
      error: 'LINE_OBS_TOKEN_RPC_FAILED', serverErrorCode: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY' as const,
      upstreamCode: 84 }));
    const service = new AttachmentService(repository, { async binding(accountId) {
      return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    }, async isReady() { return true; }, download }, undefined, 4, undefined, undefined, undefined, undefined,
    () => 0, (result) => observed.push(result));
    try {
      await expect(service.downloadById(row.attachmentId)).resolves.toBe(false);
      expect(download).toHaveBeenCalledOnce();
      expect(saved).toEqual(['LINE_OBS_TOKEN_RPC_FAILED']);
      expect(observed).toMatchObject([{ error: 'LINE_OBS_TOKEN_RPC_FAILED',
        serverErrorCode: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', upstreamCode: 84 }]);
    } finally { await service.shutdown(); }
  });

  it.each([
    ['attachment.bin', undefined],
    ['attachment.jpg', undefined],
    ['photo.jpg', 'photo.jpg'],
  ])('does not persist a synthetic worker name when the source name is missing (%s)', async (workerName, expectedName) => {
    const row = queuedAttachment('missing-display-name', undefined, { name: null });
    let readyName: string | undefined;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { return randomUUID(); },
      async markAttachmentReady(_mutation: unknown, value: { name?: string }) { readyName = value.name; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    }, async isReady() { return true; }, async download(command) {
      return { ...readyAttachmentResult(command), name: workerName };
    } });
    try {
      await expect(service.downloadById(row.attachmentId)).resolves.toBe(true);
      expect(readyName).toBe(expectedName);
    } finally { await service.shutdown(); }
  });

  it('rejects community and thread downloads before worker readiness or dispatch', async () => {
    const rows = new Map(['community', 'thread'].map((chatType) => [chatType,
      queuedAttachment(`unsupported-${chatType}`, undefined, { chatType, chatId: `chat-${chatType}` }) as unknown as Attachment]));
    let bindings = 0; let readiness = 0; let downloads = 0;
    const repository = { async getAttachment(id: string) { return rows.get(id); },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      bindings += 1; return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    }, async isReady() { readiness += 1; return true; }, async download(command) {
      downloads += 1; return readyAttachmentResult(command);
    } });
    try {
      for (const chatType of ['community', 'thread'] as const) {
        await expect(service.downloadManually({ accountId: 'a', chatType, chatId: `chat-${chatType}` }, `unsupported-${chatType}`)).resolves.toBe(false);
      }
      expect({ bindings, readiness, downloads }).toEqual({ bindings: 0, readiness: 0, downloads: 0 });
    } finally { await service.shutdown(); }
  });

  it('waits ten seconds after row creation before the first automatic claim', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T00:00:00.000Z'));
    const row = queuedAttachment('initial-delay', new Date(Date.now()));
    const calls: string[] = [];
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { row.status = 'downloading' as never; return randomUUID(); },
      async markAttachmentReady() { row.status = 'ready' as never; return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) { calls.push(`binding:${accountId}`); return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const }; },
      async isReady() { return true; }, async download(command) { calls.push('download'); return readyAttachmentResult(command); } });
    const attempt = service.downloadById(row.attachmentId);
    try {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(attempt).resolves.toBe(true);
      expect(calls).toContain('download');
    } finally { await service.shutdown(); const timers = vi.getTimerCount(); vi.useRealTimers(); expect(timers).toBe(0); }
  });

  it('keeps a burst on one global physical download slot even when configured higher', async () => {
    const rows = new Map(['burst-one', 'burst-two'].map((id) => [id, queuedAttachment(id)]));
    const repository = { async getAttachment(id: string) { return rows.get(id); }, async claimAttachmentDownload(_mutation: unknown) { return randomUUID(); },
      async markAttachmentReady(mutation: { attachmentId: string }) { rows.get(mutation.attachmentId)!.status = 'ready' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    let active = 0; let maximumActive = 0; let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const service = new AttachmentService(repository, { async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const }; },
      async isReady() { return true; }, async download(command) {
        active += 1; maximumActive = Math.max(maximumActive, active);
        if (command.attachmentId === 'burst-one') await firstGate;
        active -= 1;
        return readyAttachmentResult(command);
      } }, undefined, 4, undefined, undefined, undefined, undefined, () => 0);
    const first = service.downloadById('burst-one');
    const second = service.downloadById('burst-two');
    try {
      await vi.waitFor(() => expect(active).toBe(1));
      await Promise.resolve(); await Promise.resolve();
      expect(maximumActive).toBe(1);
      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    } finally { releaseFirst(); await service.shutdown(); }
  });

  it('offers a scoped manual attempt for exhausted failures only when that account worker is ready', async () => {
    const row = queuedAttachment('manual-exhausted', undefined, { status: 'failed', retryCount: 3 });
    let downloads = 0; let claims = 0;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { claims += 1; row.status = 'downloading' as never; return randomUUID(); },
      async markAttachmentFailed() { row.status = 'failed' as never; return true; }, async markAttachmentReady() { row.status = 'ready' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    let online = false;
    const service = new AttachmentService(repository, { async binding(accountId) { return online ? { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const } : null; },
      async isReady() { return online; }, async download(command) { downloads += 1; return readyAttachmentResult(command); } });
    try {
      await expect(service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(false);
      expect(claims).toBe(0); expect(downloads).toBe(0);
      online = true;
      await expect(service.downloadManually({ accountId: 'wrong-account', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(false);
      expect(claims).toBe(0);
      await expect(service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(true);
      expect(claims).toBe(1); expect(downloads).toBe(1);
    } finally { await service.shutdown(); }
  });

  it('does not enqueue a manual retry when the authoritative account status is disconnected', async () => {
    const row = queuedAttachment('manual-disconnected', undefined, { status: 'failed', retryCount: 3 });
    let claims = 0;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { claims += 1; return randomUUID(); },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const }; },
      async isReady() { return true; }, async download(command) { return readyAttachmentResult(command); } }, undefined, 4, undefined, undefined, undefined,
      async () => false);
    try {
      await expect(service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(false);
      expect(claims).toBe(0);
    } finally { await service.shutdown(); }
  });

  it('allows an explicit retry for a recent external attachment after its first failed attempt', async () => {
    const row = queuedAttachment('external-first-failure', undefined, { externalSource: true,
      status: 'failed', retryCount: 1 }) as unknown as Attachment;
    row.retryAfter = new Date(Date.now() + 60_000).toISOString();
    let downloads = 0;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() {
      row.status = 'downloading' as never; return randomUUID();
    }, async markAttachmentFailed() { row.status = 'failed' as never; row.retryCount += 1;
      row.retryAfter = new Date(Date.now() + 60_000).toISOString(); return true; },
      async markAttachmentReady() { row.status = 'ready' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    }, async isReady() { return true; }, async download(command) {
      downloads += 1;
      return downloads === 1 ? { ...readyAttachmentResult(command), status: 'failed' as const, error: 'retryable' }
        : readyAttachmentResult(command);
    } });
    try {
      await expect(service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(false);
      await expect(service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(true);
      expect(downloads).toBe(2);
      expect(row.status).toBe('ready');
    } finally { await service.shutdown(); }
  });

  it('rechecks the seven-day cutoff after readiness before claiming a native attachment', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
    const row = queuedAttachment('cutoff-after-ready', undefined, { externalSource: true,
      occurredAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000 + 1_000).toISOString() }) as unknown as Attachment;
    let releaseReady!: () => void; let readinessStarted!: () => void; let claims = 0; let authAcquisitions = 0; let decodes = 0; let downloads = 0;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const readyStarted = new Promise<void>((resolve) => { readinessStarted = resolve; });
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { claims++; return randomUUID(); },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    }, async isReady(_binding, canAcquireAuth) {
      readinessStarted(); await readyGate;
      if (!canAcquireAuth?.()) return false;
      authAcquisitions++; return true;
    }, async download(command) {
      downloads++; return readyAttachmentResult(command);
    } }, undefined, 4, undefined, undefined, async () => { decodes++; return null; });
    const attempt = service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId);
    try {
      await readyStarted;
      await vi.advanceTimersByTimeAsync(2_000);
      releaseReady();
      await expect(attempt).resolves.toBe(false);
      expect({ claims, authAcquisitions, decodes, downloads }).toEqual({ claims: 0, authAcquisitions: 0, decodes: 0, downloads: 0 });
    } finally { releaseReady(); await service.shutdown(); vi.useRealTimers(); }
  });

  it('cancels a claimed external attempt when native metadata decoding crosses the seven-day cutoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
    const row = queuedAttachment('cutoff-after-decode', undefined, { externalSource: true,
      occurredAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000 + 1_000).toISOString() }) as unknown as Attachment;
    let releaseDecode!: () => void; let decodeStarted!: () => void; let claims = 0; let cancelled = 0; let downloads = 0;
    const decodeGate = new Promise<void>((resolve) => { releaseDecode = resolve; });
    const decodeBegan = new Promise<void>((resolve) => { decodeStarted = resolve; });
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { claims++; return randomUUID(); },
      async cancelAttachmentDownloadBeforeDispatch() { cancelled++; row.status = 'queued' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    }, async isReady() { return true; }, async download(command) { downloads++; return readyAttachmentResult(command); } },
    undefined, 4, undefined, undefined, async () => { decodeStarted(); await decodeGate; return null; });
    const attempt = service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId);
    try {
      await decodeBegan;
      await vi.advanceTimersByTimeAsync(2_000);
      releaseDecode();
      await expect(attempt).resolves.toBe(false);
      expect({ claims, cancelled, downloads, status: row.status }).toEqual({ claims: 1, cancelled: 1, downloads: 0, status: 'queued' });
    } finally { releaseDecode(); await service.shutdown(); vi.useRealTimers(); }
  });

  it('stores a fixed safe code when the worker transport rejects with sensitive details', async () => {
    const row = queuedAttachment('worker-transport-error');
    let persistedError = '';
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { row.status = 'downloading' as never; return randomUUID(); },
      async markAttachmentFailed(_mutation: unknown, error: string) { persistedError = error; row.status = 'failed' as never; return true; },
      async cancelAttachmentDownloadBeforeDispatch() { return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const secretMessage = 'https://obs.example/object?token=DO_NOT_PERSIST';
    const service = new AttachmentService(repository, { async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; }, async download() { throw new Error(secretMessage); } });
    try {
      await expect(service.downloadById(row.attachmentId)).resolves.toBe(false);
      expect(persistedError).toBe('ATTACHMENT_ATTEMPT_FAILED');
      expect(persistedError).not.toContain('DO_NOT_PERSIST');
    } finally { await service.shutdown(); }
  });

  it('does not let a mismatched conversation join an in-flight manual attempt', async () => {
    const row = queuedAttachment('manual-scope-in-flight', undefined, { status: 'expired', retryCount: 1 });
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { row.status = 'downloading' as never; return randomUUID(); },
      async markAttachmentReady() { row.status = 'ready' as never; return true; }, async cancelAttachmentDownloadBeforeDispatch() { return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const service = new AttachmentService(repository, { async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; }, async download(command) { started(); return await new Promise<AttachmentResult>((resolve) => {
        release = () => resolve(readyAttachmentResult(command));
      }); } });
    try {
      const valid = service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId);
      await entered;
      const mismatched = service.downloadManually({ accountId: 'other', chatType: 'group', chatId: 'g' }, row.attachmentId);
      const mismatchResult = await Promise.race([mismatched, new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100))]);
      release();
      await expect(valid).resolves.toBe(true);
      expect(mismatchResult).toBe(false);
    } finally { await service.shutdown(); }
  });

  it('does not allocate per-row retry timers for a bounded attachment burst', async () => {
    vi.useFakeTimers();
    const rows = new Map(Array.from({ length: 256 }, (_, index) => {
      const row = queuedAttachment(`timer-${index}`, new Date(Date.now() + 60_000)); return [row.attachmentId, row] as const;
    }));
    const repository = { async getAttachment(id: string) { return rows.get(id); }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding() { return null; }, async isReady() { return false; }, async download() { throw new Error('unavailable'); } });
    try {
      const requests = [...rows.keys()].map((id) => service.downloadById(id));
      await Promise.resolve(); await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      expect((service as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(256);
      await service.shutdown();
      await Promise.all(requests);
    } finally { await service.shutdown(); vi.useRealTimers(); }
  });

  it('recovers an overdue offline attachment after a missed readiness notification using the bounded wake', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T00:00:00.000Z'));
    const row = queuedAttachment('missed-readiness');
    let online = false; let bindingChecks = 0; let downloads = 0;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { row.status = 'downloading' as never; return randomUUID(); },
      async markAttachmentReady() { row.status = 'ready' as never; return true; },
      async recoverAttachmentPage() { return { items: [{ accountId: row.accountId, attachmentId: row.attachmentId }], hasMore: false }; },
      async recoverAttachments() { return [row.attachmentId]; }, async nextAttachmentWakeAt() { return null; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      bindingChecks++;
      return online ? { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const } : null;
    }, async isReady() { return online; }, async download(command) { downloads++; row.status = 'ready' as never; return readyAttachmentResult(command); } });
    try {
      await service.recover();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(bindingChecks).toBe(1);
      expect(downloads).toBe(0);
      expect(vi.getTimerCount()).toBe(1);

      online = true; // Simulate readiness returning while its event is missed.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(downloads).toBe(0);
      expect(bindingChecks).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(downloads).toBe(1);
      expect(row.status).toBe('ready');
      expect(vi.getTimerCount()).toBe(1);
    } finally { await service.shutdown(); vi.useRealTimers(); }
  });

  it('returns queue resources to an idle baseline after repeated attachment bursts', async () => {
    vi.useFakeTimers();
    const rows = new Map<string, ReturnType<typeof queuedAttachment>>();
    let maximumActive = 0; let active = 0; let completed = 0;
    const repository = { async getAttachment(id: string) { return rows.get(id) ?? null; },
      async claimAttachmentDownload(mutation: { attachmentId: string }) { rows.get(mutation.attachmentId)!.status = 'downloading' as never; return randomUUID(); },
      async markAttachmentReady(mutation: { attachmentId: string }) { rows.get(mutation.attachmentId)!.status = 'ready' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async nextAttachmentWakeAt() { return null; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; }, async download(command) {
        active++; maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--; completed++;
        return readyAttachmentResult(command);
      } });
    try {
      expect(vi.getTimerCount()).toBe(0);
      for (let wave = 0; wave < 3; wave++) {
        const ids = Array.from({ length: 32 }, (_, index) => `idle-${wave}-${index}`);
        for (const id of ids) rows.set(id, queuedAttachment(id));
        const wave_ = Promise.all(ids.map((id) => service.downloadById(id))).then((results) => results.every(Boolean));
        await vi.advanceTimersByTimeAsync(ids.length * ATTACHMENT_GAP_MAX_MS + 1_000);
        await expect(wave_).resolves.toBe(true);
        const owned = service as unknown as { queued: Set<string>; waiters: Map<string, unknown>; inFlight: Map<string, unknown>; controllers: Map<string, unknown> };
        expect(owned.queued.size).toBe(0);
        expect(owned.waiters.size).toBe(0);
        expect(owned.inFlight.size).toBe(0);
        expect(owned.controllers.size).toBe(0);
        expect(vi.getTimerCount()).toBe(1);
      }
      expect(completed).toBe(96);
      expect(maximumActive).toBe(1);
    } finally { await service.shutdown(); vi.useRealTimers(); }
  });
  it('uses the decoded native filename when the imported attachment has no filename', async () => {
    const row = { ...queuedAttachment('native-no-name', undefined, { name: null, externalSource: true,
      nativePayload: { format: 1, table: 'message', sourceDigest: 'a'.repeat(64), encoding: 'dpapi', data: 'AQ==' } }),
      messageId: 'native-message', chatId: 'g' } as unknown as Attachment;
    let dispatched: Extract<LineWorkerCommand, { type: 'downloadAttachment' }> | null = null;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { return randomUUID(); },
      async markAttachmentReady() { return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const }; },
      async isReady() { return true; }, async download(command) { dispatched = command; return readyAttachmentResult(command); } },
    undefined, 1, undefined, undefined, async () => ({ messageId: 'native-message', chatId: 'g', from: null, to: null,
      toType: null, contentType: 1, contentMetadata: { OID: 'oid', SID: null, OBS_POP: null, FILE_SIZE: null,
        MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null }, keyMaterial: null, fileName: 'photo.png', sizeBytes: null }));
    try {
      await expect(service.downloadManually({ accountId: row.accountId, chatType: row.chatType, chatId: row.chatId }, row.attachmentId)).resolves.toBe(true);
      expect(dispatched).toMatchObject({ originalFileName: 'photo.png', nativeAttachment: { fileName: 'photo.png' } });
    } finally { await service.shutdown(); }
  });

  it('rejects an old external attachment before checking worker readiness or decoding metadata', async () => {
    const row = { ...queuedAttachment('old-native', undefined, { externalSource: true,
      occurredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString() }) };
    let workerChecks = 0; let claims = 0; let metadataReads = 0;
    const repository = { async getAttachment() { return row; }, async claimAttachmentDownload() { claims++; return randomUUID(); },
      async markAttachmentReady() { return true; }, async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding() { workerChecks++; return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const }; },
      async isReady() { workerChecks++; return true; }, async download(command) { return readyAttachmentResult(command); } },
    undefined, 1, undefined, undefined, async () => { metadataReads++; return null; });
    try {
      await expect(service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, row.attachmentId)).resolves.toBe(false);
      await expect(service.downloadById(row.attachmentId)).resolves.toBe(false);
      expect(workerChecks).toBe(0);
      expect(claims).toBe(0);
      expect(metadataReads).toBe(0);
    } finally { await service.shutdown(); }
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('AttachmentService on PostgreSQL', () => {
  let pool: Pool; let close: () => Promise<void>; let messages: MessageRepository; let attachmentId: string;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase()); messages = new MessageRepository(pool);
    const accounts = new AccountRepository(pool); await accounts.ensureAccount('a'); await accounts.activateControl('a', 1);
    await messages.ingestAndRoute({ eventId: 'e', accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: 'm',
      kind: 'image', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z',
      raw: { message: { id: 'm', chunks: [{ encoding: 'base64', data: 'AQID' }], contentMetadata: { OID: 'line-object', SID: 'emi' } } },
      attachments: [{ id: 'line-object', kind: 'image', name: 'image.jpg', mimeType: 'image/jpeg', sizeBytes: null }] }, { eligible: false });
    attachmentId = (await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, 'm', 'line-object'))!.attachmentId;
  });
  beforeEach(async () => {
    await new AccountRepository(pool).bindWorker({ accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1 });
    await pool.query("ALTER TABLE attachments ALTER COLUMN created_at SET DEFAULT now() - interval '11 seconds'");
    await pool.query("UPDATE attachments SET created_at = now() - interval '11 seconds' WHERE status = 'queued' AND retry_count = 0");
  });
  afterAll(async () => { await close?.(); });
  it('downloads by authoritative ID and records a ready managed path', async () => {
    const commands: LineWorkerCommand[] = [];
    const service = new AttachmentService(messages, { async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const }; },
      async isReady() { return true; },
      async download(command) { commands.push(command); return { type: 'attachmentResult' as const, status: 'ready' as const,
        accountId: 'a', chatType: 'group' as const, chatId: 'g', attachmentId, attemptToken: command.attemptToken, workerInstanceId: 'worker',
        relativePath: 'accounts/a/image.blob', sha256: 'a'.repeat(64), sizeBytes: 12, name: '原始圖片.jpg' }; } });
    try {
      expect(await service.downloadById(attachmentId)).toBe(true);
      expect(commands).toMatchObject([{ type: 'downloadAttachment', accountId: 'a', chatType: 'group', chatId: 'g',
        messageId: 'm', attachmentId, externalAttachmentId: 'line-object', kind: 'image' }]);
      expect(commands[0]).toMatchObject({ lineMessage: { id: 'm', chunks: [{ encoding: 'base64', data: 'AQID' }] } });
      expect(await messages.getAttachment(attachmentId)).toMatchObject({ status: 'ready', relativePath: 'accounts/a/image.blob', name: '原始圖片.jpg' });
    } finally { await service.shutdown(); }
  });
  it('rejects a repeated download once ready', async () => {
    const service = new AttachmentService(messages, { async binding() { throw new Error('should not contact worker'); },
      async isReady() { return true; }, async download() { throw new Error('should not download'); } });
    try { expect(await service.downloadById(attachmentId)).toBe(false); } finally { await service.shutdown(); }
  });
  it('does not claim or dispatch until the exact worker has completed login and ready acknowledgement', async () => {
    const messageId = `login-readiness-${randomUUID()}`;
    const externalId = `login-readiness-${randomUUID()}`;
    await messages.ingestAndRoute({ eventId: messageId, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId,
      kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
      attachments: [{ id: externalId, kind: 'file', name: 'login-ready.txt', mimeType: 'text/plain', sizeBytes: null }] }, { eligible: false });
    const id = (await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, messageId, externalId))!.attachmentId;
    let ready = false;
    let calls = 0;
    const worker = {
      async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return ready; },
      async download(command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>) {
        calls++;
        return { type: 'attachmentResult' as const, status: 'ready' as const, accountId: 'a', chatType: 'group' as const,
          chatId: 'g', attachmentId: id, attemptToken: command.attemptToken, workerInstanceId: 'worker',
          relativePath: 'accounts/a/login-ready.txt', sha256: 'b'.repeat(64), sizeBytes: 1, name: 'login-ready.txt' };
      },
    };
    const service = new AttachmentService(messages, worker);
    expect(await service.downloadById(id)).toBe(false);
    expect(calls).toBe(0);
    expect(await messages.getAttachment(id)).toMatchObject({ status: 'queued' });

    ready = true;
    expect(await service.downloadById(id)).toBe(true);
    expect(calls).toBe(1);
    await service.shutdown();
  });
  it('checks one fair global candidate for an account with unavailable rows', { timeout: 90_000 }, async () => {
    const ids: string[] = [];
    for (let index = 0; index < 260; index += 1) {
      const suffix = `unavailable-page-${index}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      ids.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    let bindingChecks = 0; let downloads = 0;
    const scan = vi.spyOn(messages, 'recoverAttachmentPage');
    const service = new AttachmentService(messages, { async binding() { bindingChecks++; return null; },
      async isReady() { return false; }, async download() { downloads++; throw new Error('unavailable worker must not download'); } });
    try {
      await service.recover();
      await vi.waitFor(() => expect(bindingChecks).toBe(1), { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scan).toHaveBeenCalled();
      expect(scan.mock.calls[0]?.[0]).toBeNull();
      expect(scan.mock.calls[0]?.[1]).toBe(16);
      expect(bindingChecks).toBeGreaterThanOrEqual(1);
      expect(downloads).toBe(0);
      const rows = await pool.query("SELECT count(*)::int AS count, max(retry_count)::int AS retries FROM attachments WHERE attachment_id = ANY($1::uuid[])", [ids]);
      expect(rows.rows[0]).toEqual({ count: ids.length, retries: 0 });
      await service.shutdown();
    } finally {
      scan.mockRestore(); await service.shutdown();
      await pool.query("UPDATE attachments SET status = 'expired' WHERE attachment_id = ANY($1::uuid[])", [ids]);
    }
  });
  it('advances past an unavailable first page to dispatch an eligible attachment on the next page', { timeout: 90_000 }, async () => {
    const accounts = new AccountRepository(pool); await accounts.ensureAccount('recovery-eligible');
    const unavailable: string[] = [];
    for (let index = 0; index < 256; index += 1) {
      const suffix = `unavailable-before-eligible-${index}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      unavailable.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    const eligibleMessage = `eligible-after-first-page-${randomUUID()}`;
    await messages.ingestAndRoute({ eventId: eligibleMessage, accountId: 'recovery-eligible', chatType: 'group', chatId: 'g', senderId: 'u', messageId: eligibleMessage,
      kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
      attachments: [{ id: eligibleMessage, kind: 'file', name: eligibleMessage, mimeType: null, sizeBytes: null }] }, { eligible: false });
    const eligible = (await messages.getAttachmentBySource({ accountId: 'recovery-eligible', chatType: 'group', chatId: 'g' }, eligibleMessage, eligibleMessage))!;
    await pool.query("UPDATE attachments SET attachment_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE attachment_id = $1", [eligible.attachmentId]);
    await accounts.bindWorker({ accountId: 'recovery-eligible', workerInstanceId: 'eligible-worker', controlEpoch: 1 });
    let downloads = 0;
    const scan = vi.spyOn(messages, 'recoverAttachmentPage');
    const service = new AttachmentService(messages, { async binding(accountId) {
      return accountId === 'recovery-eligible' ? { accountId, workerInstanceId: 'eligible-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const } : null;
    }, async isReady() { return true; }, async download(command) { downloads++; return { type: 'attachmentResult' as const, status: 'ready' as const,
      accountId: command.accountId, chatType: command.chatType, chatId: command.chatId, attachmentId: command.attachmentId,
      attemptToken: command.attemptToken, workerInstanceId: command.workerInstanceId, relativePath: 'eligible/one.blob',
      sha256: 'c'.repeat(64), sizeBytes: 1, name: 'one' }; } });
    try {
      await service.recover();
      await vi.waitFor(async () => expect((await messages.getAttachment('ffffffff-ffff-ffff-ffff-ffffffffffff'))?.status).toBe('ready'), { timeout: 10_000 });
      expect(downloads).toBe(1);
      expect(scan).toHaveBeenCalled();
      expect(scan.mock.calls[0]?.[0]).toBeNull();
      // This service is never given a worker for account 'a', and downloads===1 above proves it dispatched only the
      // eligible row; every other service in this file is shut down by its own test, so the rest stay queued.
      const unavailableRow = (await messages.getAttachment(unavailable[0]!))?.status;
      expect(unavailableRow, `unavailable row status ${unavailableRow}`).toBe('queued');
    } finally {
      scan.mockRestore(); await service.shutdown();
      await pool.query("UPDATE attachments SET status = 'expired' WHERE attachment_id = ANY($1::uuid[])", [unavailable]);
      await pool.query('UPDATE attachments SET attachment_id = $1 WHERE attachment_id = $2', [eligible.attachmentId, 'ffffffff-ffff-ffff-ffff-ffffffffffff']);
    }
  });
  it('leaves same-account recovery backlog durable while one global slot is active', { timeout: 90_000 }, async () => {
    const scopedAccount = `scoped-admission-${randomUUID()}`;
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(scopedAccount);
    await accounts.bindWorker({ accountId: scopedAccount, workerInstanceId: 'scoped-worker', controlEpoch: 1 });
    const ids: string[] = [];
    for (let index = 0; index < 255; index += 1) {
      const suffix = `scoped-admission-tail-${randomUUID()}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: scopedAccount, chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      ids.push((await messages.getAttachmentBySource({ accountId: scopedAccount, chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    const activeIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const suffix = `scoped-admission-active-${randomUUID()}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: scopedAccount, chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      activeIds.push((await messages.getAttachmentBySource({ accountId: scopedAccount, chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    ids.sort();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    let activeStarted = 0;
    const scan = vi.spyOn(messages, 'recoverAttachments');
    const service = new AttachmentService(messages, { async binding(accountId) {
      return { accountId, workerInstanceId: 'scoped-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    }, async isReady() { return true; }, async download(command) {
      if (activeIds.includes(command.attachmentId)) {
        activeStarted += 1;
        await activeGate;
      }
      return { type: 'attachmentResult' as const, status: 'failed' as const, accountId: command.accountId, chatType: 'group' as const,
        chatId: 'g', attachmentId: command.attachmentId, attemptToken: command.attemptToken,
        workerInstanceId: command.workerInstanceId, error: 'test failure' };
    } });
    try {
      const activeRequests = activeIds.map((id) => service.downloadById(id));
      await vi.waitFor(() => expect(activeStarted).toBe(1));
      await service.recover(scopedAccount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(activeStarted).toBe(1);
      expect((await messages.getAttachment(activeIds[0]!))?.status).toBe('downloading');
      expect((await messages.getAttachment(activeIds[1]!))?.status).toBe('queued');
      expect((await Promise.all(ids.map((id) => messages.getAttachment(id)))).every((row) => row?.status === 'queued')).toBe(true);
      releaseActive();
      await Promise.all(activeRequests);
      expect(activeStarted).toBe(2);
    } finally {
      releaseActive();
      scan.mockRestore(); await service.shutdown();
      await pool.query("UPDATE attachments SET status = 'expired' WHERE attachment_id = ANY($1::uuid[])", [[...ids, ...activeIds]]);
    }
  });
  it('resumes deferred recovery when readiness returns and keeps downloads within the global cap', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const suffix = `readiness-recovery-${index}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      ids.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    ids.sort();
    let ready = false; let active = 0; let peak = 0; let readinessChecks = 0;
    const gates = new Map<string, (event: AttachmentResult) => void>();
    const tokens = new Map<string, string>();
    const service = new AttachmentService(messages, { async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { readinessChecks++; return ready; }, async download(command) {
        active++; peak = Math.max(peak, active); tokens.set(command.attachmentId, command.attemptToken);
        return await new Promise<AttachmentResult>((resolve) => gates.set(command.attachmentId, (event) => { active--; resolve(event); }));
      } });
    withoutGap(service);
    try {
      await service.recover('a');
      await vi.waitFor(() => expect(readinessChecks).toBe(5));
      expect(gates.size).toBe(0);
      expect(await Promise.all(ids.map(async (id) => (await messages.getAttachment(id))?.retryCount))).toEqual(ids.map(() => 0));
      ready = true;
      await service.recover('a');
      await vi.waitFor(() => expect(gates.size).toBe(1), { timeout: 2_000 });
      gates.get(ids[0]!)!({ type: 'attachmentResult', status: 'ready', accountId: 'a', chatType: 'group', chatId: 'g', attachmentId: ids[0]!,
        attemptToken: tokens.get(ids[0]!)!, workerInstanceId: 'worker', relativePath: 'recovered/0.blob', sha256: 'd'.repeat(64), sizeBytes: 1, name: '0' });
      for (const id of ids.slice(1)) {
        await vi.waitFor(() => expect(gates.has(id)).toBe(true), { timeout: 2_000 });
        gates.get(id)!({ type: 'attachmentResult', status: 'ready', accountId: 'a', chatType: 'group', chatId: 'g', attachmentId: id,
          attemptToken: tokens.get(id)!, workerInstanceId: 'worker', relativePath: `recovered/${id}.blob`, sha256: 'e'.repeat(64), sizeBytes: 1, name: 'file' });
      }
      await vi.waitFor(async () => expect((await Promise.all(ids.map((id) => messages.getAttachment(id)))).filter((item) => item?.status === 'ready')).toHaveLength(5), { timeout: 2_000 });
      expect(peak).toBe(1);
    } finally { await service.shutdown(); }
  });
  // Seeds 260 attachments one ingest at a time; which takes longer than the 15 s default test timeout.
  it('preserves overlapping account recovery scopes across a full first page', { timeout: 90_000 }, async () => {
    const accounts = new AccountRepository(pool); await accounts.ensureAccount('overlap-b');
    const accountAIds: string[] = [];
    for (let index = 0; index < 260; index += 1) {
      const suffix = `overlap-a-${index}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      accountAIds.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    accountAIds.sort();
    const suffixB = `overlap-b-${randomUUID()}`;
    await messages.ingestAndRoute({ eventId: suffixB, accountId: 'overlap-b', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffixB,
      kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
      attachments: [{ id: suffixB, kind: 'file', name: suffixB, mimeType: null, sizeBytes: null }] }, { eligible: false });
    const idB = (await messages.getAttachmentBySource({ accountId: 'overlap-b', chatType: 'group', chatId: 'g' }, suffixB, suffixB))!.attachmentId;
    await pool.query("UPDATE attachments SET attachment_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE attachment_id = $1", [idB]);
    await accounts.bindWorker({ accountId: 'overlap-b', workerInstanceId: 'overlap-b-worker', controlEpoch: 1 });
    let active = 0; let peak = 0; let gatedA = 0;
    const calls: string[] = []; const calledIds = new Set<string>();
    const gates = new Map<string, (result: AttachmentResult) => void>();
    const tokens = new Map<string, string>();
    const scan = vi.spyOn(messages, 'recoverAttachments');
    const service = new AttachmentService(messages, { async binding(accountId) {
      return accountId === 'a' ? { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }
        : { accountId, workerInstanceId: 'overlap-b-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    }, async isReady() { return true; }, async download(command) {
      active++; peak = Math.max(peak, active); calls.push(command.accountId); tokens.set(command.attachmentId, command.attemptToken);
      calledIds.add(command.attachmentId);
      if (command.accountId === 'a' && gatedA < 4) {
        gatedA++;
        return await new Promise<AttachmentResult>((resolve) => gates.set(command.attachmentId, (result) => { active--; resolve(result); }));
      }
      active--;
      return { type: 'attachmentResult', status: 'ready', accountId: command.accountId, chatType: command.chatType, chatId: command.chatId,
        attachmentId: command.attachmentId, attemptToken: command.attemptToken, workerInstanceId: command.workerInstanceId,
        relativePath: `overlap/${command.attachmentId}.blob`, sha256: 'f'.repeat(64), sizeBytes: 1, name: 'ready' };
    } });
    withoutGap(service);
    try {
      await service.recover('a');
      for (let index = 0; index < 4; index += 1) {
        const nextId = accountAIds[index]!;
        await vi.waitFor(() => expect(gates.has(nextId)).toBe(true), { timeout: 3_000 });
        if (index === 0) await service.recover('overlap-b');
        gates.get(nextId)!({ type: 'attachmentResult', status: 'ready', accountId: 'a', chatType: 'group', chatId: 'g',
          attachmentId: nextId, attemptToken: tokens.get(nextId)!, workerInstanceId: 'worker', relativePath: `overlap/${nextId}.blob`,
          sha256: 'f'.repeat(64), sizeBytes: 1, name: 'ready' });
      }
      for (const [attachmentId, release] of gates) release({ type: 'attachmentResult', status: 'ready', accountId: 'a', chatType: 'group', chatId: 'g',
        attachmentId, attemptToken: tokens.get(attachmentId)!, workerInstanceId: 'worker', relativePath: `overlap/${attachmentId}.blob`,
        sha256: 'f'.repeat(64), sizeBytes: 1, name: 'ready' });
      // beforeEach defaults created_at to now()-11s, so the 10 s age rule (02b24dd) does not delay any row here.
      try {
        await vi.waitFor(() => expect(calls.filter((accountId) => accountId === 'a')).toHaveLength(260), { timeout: 15_000 });
      } catch (error) {
        // Name the rows that never reached the worker, with their durable state, instead of a bare 259/260.
        const missing = accountAIds.filter((id) => !calledIds.has(id));
        const rows = await pool.query('SELECT attachment_id,status,retry_count,retry_after,error,download_owner_id,created_at,updated_at,now() AS db_now FROM attachments WHERE attachment_id = ANY($1::uuid[])', [missing]);
        throw new Error(`${String(error)}; missing=${JSON.stringify(rows.rows)}`);
      }
      await vi.waitFor(() => expect(calls.filter((accountId) => accountId === 'overlap-b')).toHaveLength(1), { timeout: 5_000 });
      expect(scan.mock.calls.some(([accountId]) => accountId === 'a')).toBe(true);
      expect(scan.mock.calls.some(([accountId]) => accountId === 'overlap-b')).toBe(true);
      expect(peak).toBe(1);
      await vi.waitFor(async () => expect((await messages.getAttachment(accountAIds[259]!))?.status).toBe('ready'));
      await vi.waitFor(async () => expect((await messages.getAttachment('ffffffff-ffff-ffff-ffff-ffffffffffff'))?.status).toBe('ready'));
    } finally { scan.mockRestore(); await service.shutdown(); }
  });
  it('drains queued waiters and recovery state on shutdown during overlapping scans', { timeout: 90_000 }, async () => {
    const accounts = new AccountRepository(pool); await accounts.ensureAccount('shutdown-overlap-b');
    const shutdownOverlapIds: string[] = [];
    let service: AttachmentService | undefined;
    try {
      for (let index = 0; index < 260; index += 1) {
        const suffix = `shutdown-overlap-a-${index}`;
        await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
          kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
          ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
          attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
        shutdownOverlapIds.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
      }
      const suffixB = `shutdown-overlap-b-${randomUUID()}`;
      await messages.ingestAndRoute({ eventId: suffixB, accountId: 'shutdown-overlap-b', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffixB,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffixB, kind: 'file', name: suffixB, mimeType: null, sizeBytes: null }] }, { eligible: false });
      shutdownOverlapIds.push((await messages.getAttachmentBySource({ accountId: 'shutdown-overlap-b', chatType: 'group', chatId: 'g' }, suffixB, suffixB))!.attachmentId);
      await accounts.bindWorker({ accountId: 'shutdown-overlap-b', workerInstanceId: 'shutdown-overlap-b-worker', controlEpoch: 1 });
      let calls = 0;
      service = new AttachmentService(messages, { async binding(accountId) {
        return { accountId, workerInstanceId: accountId === 'a' ? 'worker' : 'shutdown-overlap-b-worker', controlEpoch: 1,
          mode: 'ACTIVE_CONTROL' as const };
      }, async isReady() { return true; }, async download(_command, signal) {
        calls++;
        return await new Promise<AttachmentResult>((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error('cancelled'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      } });
      const owned = service as unknown as {
        waiters: Map<string, { promise: Promise<boolean> }>;
        queued: Set<string>;
        inFlight: Map<string, Promise<boolean>>;
        recoveryScans: unknown[];
        scanGenerations: Map<string | undefined, number>;
      };
      await service.recover('a');
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 3_000 });
      await service.recover('shutdown-overlap-b');
      const pending = [...owned.waiters.values()].map(({ promise }) => promise);
      expect(owned.queued.size).toBe(255);
      expect(owned.recoveryScans).toHaveLength(2);
      expect(owned.scanGenerations.size).toBe(2);

      await service.shutdown();
      await Promise.allSettled(pending);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls).toBe(1);
      expect(owned.waiters.size).toBe(0);
      expect(owned.queued.size).toBe(0);
      expect(owned.inFlight.size).toBe(0);
      expect(owned.recoveryScans).toHaveLength(0);
      expect(owned.scanGenerations.size).toBe(0);
    } finally {
      try { await service?.shutdown(); }
      finally {
        if (shutdownOverlapIds.length > 0) {
          await pool.query("UPDATE attachments SET status = 'expired', download_attempt_token = NULL, download_owner_id = NULL, download_worker_instance_id = NULL, download_worker_binding_epoch = NULL, download_lease_expires_at = NULL WHERE attachment_id = ANY($1::uuid[])", [shutdownOverlapIds]);
        }
      }
    }
  });
  it('backs off a failed download and recovers it after the retry window', async () => {
    await messages.ingestAndRoute({ eventId: 'e2', accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: 'm2',
      kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
      attachments: [{ id: 'line-object-2', kind: 'file', name: 'doc.txt', mimeType: 'text/plain', sizeBytes: null }] }, { eligible: false });
    const id = (await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, 'm2', 'line-object-2'))!.attachmentId;
    let calls = 0;
    const service = new AttachmentService(messages, { async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(command) { calls++; return { type: 'attachmentResult' as const, status: 'failed' as const, accountId: 'a', chatType: 'group' as const,
        chatId: 'g', attachmentId: id, attemptToken: command.attemptToken, workerInstanceId: 'worker', error: 'temporary' }; } });
    expect(await service.downloadById(id)).toBe(false);
    let secondSettled = false;
    const second = service.downloadById(id).then((value) => { secondSettled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(secondSettled).toBe(false);
    expect(calls).toBe(1);
    await pool.query("UPDATE attachments SET retry_after = now() - interval '1 second' WHERE attachment_id = $1", [id]);
    await service.recover('a');
    expect(await second).toBe(false);
    expect(calls).toBe(2);
    const row = await pool.query('SELECT retry_count FROM attachments WHERE attachment_id = $1', [id]);
    expect(row.rows[0].retry_count).toBe(2);
  });

  it('leaves burst work queued in the database when all global download slots are occupied', async () => {
    const ids: string[] = [];
    for (const suffix of ['burst-1', 'burst-2']) {
      await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      ids.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    let entered!: () => void; let finish!: (value: never) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<never>((resolve) => { finish = resolve; });
    let downloads = 0;
    const service = new AttachmentService(messages, { async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(_command, signal) {
        downloads++; entered();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('cancelled')), { once: true });
          blocked.catch(reject);
        });
      } }, undefined, 1);
    const first = service.downloadById(ids[0]!);
    await started;
    const second = await Promise.race([service.downloadById(ids[1]!), new Promise<'still-waiting'>((resolve) => setTimeout(() => resolve('still-waiting'), 250))]);
    expect(second).toBe('still-waiting');
    expect(downloads).toBe(1);
    expect(await messages.getAttachment(ids[1]!)).toMatchObject({ status: 'queued' });
    await (service as unknown as { shutdown(): Promise<void> }).shutdown();
    await first;
    finish(undefined as never);
  });

  it('automatically dispatches the fifth queued attachment when a global slot is released', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const suffix = `dispatcher-${index}`;
      await messages.ingestAndRoute({ eventId: suffix, accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      ids.push((await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId);
    }
    const gates = new Map<string, (event: AttachmentResult) => void>();
    const tokens = new Map<string, string>();
    const service = new AttachmentService(messages, {
      async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(command) {
        tokens.set(command.attachmentId, command.attemptToken);
        const pending = new Promise<AttachmentResult>((resolve) => gates.set(command.attachmentId, resolve));
        return await pending;
      },
    });

    withoutGap(service);
    const tasks = ids.map((id) => service.downloadById(id));
    await vi.waitFor(() => expect(gates.size).toBe(1), { timeout: 2_000 });
    expect(await messages.getAttachment(ids[4]!)).toMatchObject({ status: 'queued' });
    gates.get(ids[0]!)!({ type: 'attachmentResult', status: 'failed', accountId: 'a', chatType: 'group', chatId: 'g',
      attachmentId: ids[0], attemptToken: tokens.get(ids[0]!),
      workerInstanceId: 'worker', error: 'temporary' } as never);
    for (const id of ids.slice(1, 4)) {
      await vi.waitFor(() => expect(gates.has(id)).toBe(true));
      gates.get(id)!({ type: 'attachmentResult', status: 'failed', accountId: 'a', chatType: 'group', chatId: 'g',
        attachmentId: id, attemptToken: tokens.get(id)!, workerInstanceId: 'worker', error: 'temporary' } as never);
    }
    await vi.waitFor(() => expect(gates.has(ids[4]!)).toBe(true));
    expect(await messages.getAttachment(ids[4]!)).toMatchObject({ status: 'downloading' });
    gates.get(ids[4]!)!({ type: 'attachmentResult', status: 'failed', accountId: 'a', chatType: 'group', chatId: 'g',
      attachmentId: ids[4]!, attemptToken: tokens.get(ids[4]!)!, workerInstanceId: 'worker', error: 'temporary' } as never);
    await Promise.all(tasks);
    await service.shutdown();
  });

  it('recovers invalid owners immediately and delays a stale claimed attempt by ten seconds', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('b');
    await accounts.bindWorker({ accountId: 'a', workerInstanceId: 'worker-a-live', controlEpoch: 1 });
    await accounts.bindWorker({ accountId: 'b', workerInstanceId: 'worker-b-live', controlEpoch: 1 });
    const ids: string[] = [];
    for (const [accountId, suffix, workerInstanceId] of [
      ['a', 'recovery-a', 'worker-a-dead'], ['b', 'recovery-b', 'worker-b-live'], ['a', 'recovery-a-expired', 'worker-a-live'],
    ] as const) {
      await messages.ingestAndRoute({ eventId: suffix, accountId, chatType: 'group', chatId: 'g', senderId: 'u', messageId: suffix,
        kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
        attachments: [{ id: suffix, kind: 'file', name: suffix, mimeType: null, sizeBytes: null }] }, { eligible: false });
      const id = (await messages.getAttachmentBySource({ accountId, chatType: 'group', chatId: 'g' }, suffix, suffix))!.attachmentId;
      ids.push(id);
      await messages.markAttachmentDownloading({ accountId, chatType: 'group', chatId: 'g', attachmentId: id, workerInstanceId, controlEpoch: 1 });
    }
    await pool.query("UPDATE attachments SET download_lease_expires_at = now() - interval '1 second' WHERE attachment_id = $1", [ids[2]]);
    await pool.query('UPDATE attachments SET retry_count = 1 WHERE attachment_id = $1', [ids[2]]);
    const recovered = await (messages as unknown as { recoverAttachments(accountId: string): Promise<string[]> }).recoverAttachments('a');
    expect(recovered).toContain(ids[0]);
    expect(recovered).not.toContain(ids[2]);
    expect(recovered).not.toContain(ids[1]);
    expect(await messages.getAttachment(ids[2]!)).toMatchObject({ status: 'failed', retryCount: 1 });
    const delay = await pool.query<{ seconds: number }>("SELECT extract(epoch FROM retry_after - now())::float AS seconds FROM attachments WHERE attachment_id = $1", [ids[2]]);
    expect(delay.rows[0]!.seconds).toBeGreaterThan(8);
    expect(delay.rows[0]!.seconds).toBeLessThanOrEqual(10);
    await pool.query("UPDATE attachments SET retry_after = now() WHERE attachment_id = $1", [ids[2]]);
    expect(await messages.recoverAttachments('a')).toContain(ids[2]);
    expect(await messages.getAttachment(ids[1]!)).toMatchObject({ status: 'downloading' });
  });

  it('cancels active downloads and waits only for a bounded shutdown drain', async () => {
    await messages.ingestAndRoute({ eventId: 'cancel-download', accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: 'cancel-download',
      kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
      attachments: [{ id: 'cancel-download', kind: 'file', name: 'cancel', mimeType: null, sizeBytes: null }] }, { eligible: false });
    const cancelId = (await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, 'cancel-download', 'cancel-download'))!.attachmentId;
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const service = new AttachmentService(messages, { async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(_command, signal) { started(); return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } });
    const download = (service.downloadById as (id: string, signal?: AbortSignal) => Promise<boolean>)(cancelId, controller.signal);
    await entered;
    controller.abort();
    expect(await download).toBe(false);
    await (service as unknown as { shutdown(): Promise<void> }).shutdown();
    expect(await service.downloadById(cancelId)).toBe(false);
  });

  it('caps explicit request admission and clears all queued waiters on shutdown', async () => {
    const attachment = { attachmentId: 'memory-0', externalAttachmentId: 'external', accountId: 'a', chatType: 'group' as const,
      chatId: 'g', messageId: 'm', kind: 'file' as const, name: 'x', mimeType: null, status: 'queued' as const,
      relativePath: null, sha256: null, sizeBytes: null, error: null, occurredAt: '2026-10-15T00:00:00.000Z', retryCount: 0, lineMessage: {} };
    const fakeMessages = {
      async getAttachment(id: string) { return { ...attachment, attachmentId: id }; },
      async claimAttachmentDownload() { return 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1'; },
      async cancelAttachmentDownload() { return true; }, async revokeAttachmentOwner() {},
    } as unknown as MessageRepository;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const service = new AttachmentService(fakeMessages, {
      async binding() { return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(_command, signal) {
        entered();
        return new Promise<AttachmentResult>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      },
    }, undefined, 1);
    const requests = Array.from({ length: 10_000 }, (_, index) => service.downloadById(`memory-${index}`));
    await started;
    const state = service as unknown as { queued: Set<string>; waiters: Map<string, unknown> };
    expect(state.waiters.size).toBeLessThanOrEqual(256);
    expect(state.queued.size).toBeLessThanOrEqual(255);
    await service.shutdown();
    expect(await Promise.all(requests.slice(0, 256))).toEqual(Array(256).fill(false));
    expect(state.waiters.size).toBe(0);
    expect(state.queued.size).toBe(0);
    expect(await Promise.all(requests.slice(256))).toEqual(Array(9_744).fill(false));
  });

  it('round-robins bounded recovery pages so an online account after 256 offline accounts is reached', async () => {
    const accounts = Array.from({ length: 256 }, (_, index) => `offline-${String(index).padStart(3, '0')}`);
    const onlineAccount = 'zzz-online';
    const ids = [...accounts, onlineAccount].map((accountId) => `attachment-${accountId}`);
    const attachment = (attachmentId: string, accountId: string) => ({ attachmentId, externalAttachmentId: 'external', accountId,
      chatType: 'group' as const, chatId: 'chat', messageId: 'message', kind: 'file' as const, name: 'x', mimeType: null,
      status: 'queued' as const, relativePath: null, sha256: null, sizeBytes: null, error: null,
      occurredAt: '2026-10-15T00:00:00.000Z', retryCount: 0, lineMessage: {} });
    const rows = new Map(ids.map((id, index) => [id, attachment(id, [...accounts, onlineAccount][index]!)]));
    const pageCalls: string[] = [];
    const messages = {
      async recoverAttachmentPage(afterAccountId: string | null, limit: number) {
        const pending = [...rows.values()].filter((row) => afterAccountId === null || row.accountId > afterAccountId);
        const items = pending.slice(0, limit).map((row) => ({ accountId: row.accountId, attachmentId: row.attachmentId }));
        pageCalls.push(afterAccountId ?? '<start>');
        return { items, hasMore: pending.length > items.length };
      },
      async getAttachment(id: string) { return rows.get(id) ?? null; },
      async claimAttachmentDownload() { return 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1'; },
      async markAttachmentReady() { return true; }, async recoverAttachments() { return []; }, async revokeAttachmentOwner() {},
    } as unknown as MessageRepository;
    let downloads = 0;
    const service = new AttachmentService(messages, {
      async binding(accountId) { return accountId === onlineAccount
        ? { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const } : null; },
      async isReady() { return true; },
      async download(command) { downloads += 1; return { type: 'attachmentResult', accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, chatType: command.chatType, chatId: command.chatId,
        attachmentId: command.attachmentId, attemptToken: command.attemptToken, status: 'ready',
        relativePath: 'managed/online.blob', sha256: 'a'.repeat(64), sizeBytes: 1, name: 'online' }; },
    });
    await service.recover();
    await vi.waitFor(() => expect(downloads).toBe(1), { timeout: 2_000 });
    expect(pageCalls.length).toBeGreaterThanOrEqual(17);
    await service.shutdown();
  });

  it('retries a truncated global page from the last consumed account cursor', async () => {
    const rows = new Map(['a', 'b', 'c'].map((accountId) => [accountId, {
      attachmentId: `attachment-${accountId}`, externalAttachmentId: 'external', accountId,
      chatType: 'group' as const, chatId: 'chat', messageId: 'message', kind: 'file' as const, name: accountId, mimeType: null,
      status: 'queued' as 'queued' | 'ready', relativePath: null, sha256: null, sizeBytes: null, error: null,
      occurredAt: '2026-10-15T00:00:00.000Z', retryCount: 0, lineMessage: {},
    }]));
    const pageCursors: Array<string | null> = [];
    let releaseFirstPage!: () => void;
    let firstPageStarted!: () => void;
    const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
    const firstPageEntered = new Promise<void>((resolve) => { firstPageStarted = resolve; });
    const messages = {
      async recoverAttachmentPage(afterAccountId: string | null, limit: number) {
        pageCursors.push(afterAccountId);
        if (pageCursors.length === 1) { firstPageStarted(); await firstPageGate; }
        const pending = [...rows.values()].filter((row) => row.status === 'queued' && (afterAccountId === null || row.accountId > afterAccountId));
        const items = pending.slice(0, Math.min(2, limit)).map((row) => ({ accountId: row.accountId, attachmentId: row.attachmentId }));
        return { items, hasMore: pending.length > items.length };
      },
      async getAttachment(id: string) { return [...rows.values()].find((row) => row.attachmentId === id) ?? null; },
      async claimAttachmentDownload() { return 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1'; },
      async markAttachmentReady(mutation: { attachmentId: string }) {
        const row = [...rows.values()].find((candidate) => candidate.attachmentId === mutation.attachmentId);
        if (!row) return false;
        row.status = 'ready';
        return true;
      },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {},
    } as unknown as MessageRepository;
    const downloaded: string[] = [];
    const service = new AttachmentService(messages, {
      async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(command) {
        downloaded.push(command.accountId);
        return { type: 'attachmentResult' as const, status: 'ready' as const, accountId: command.accountId,
          chatType: command.chatType, chatId: command.chatId, attachmentId: command.attachmentId,
          attemptToken: command.attemptToken, workerInstanceId: command.workerInstanceId,
          relativePath: `managed/${command.accountId}.blob`, sha256: 'a'.repeat(64), sizeBytes: 1, name: command.accountId };
      },
    }, undefined, 1);
    withoutGap(service);
    try {
      await service.recover();
      await firstPageEntered;
      const directRequests = Array.from({ length: 256 }, (_, index) => service.downloadById(`unavailable-${index}`));
      expect((service as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(256);
      releaseFirstPage();
      await Promise.all(directRequests);
      await vi.waitFor(() => expect(downloaded).toEqual(['a', 'b', 'c']), { timeout: 5_000 });
      expect(pageCursors.slice(0, 3)).toEqual([null, null, 'b']);
    } finally {
      releaseFirstPage();
      await service.shutdown();
    }
  });

  it('continues a truncated terminal global page before scheduling a later retry', async () => {
    const rows = new Map(['a', 'b'].map((accountId) => [accountId, {
      attachmentId: `terminal-attachment-${accountId}`, externalAttachmentId: 'external', accountId,
      chatType: 'group' as const, chatId: 'chat', messageId: 'message', kind: 'file' as const, name: accountId, mimeType: null,
      status: 'queued' as 'queued' | 'ready', relativePath: null, sha256: null, sizeBytes: null, error: null,
      occurredAt: '2026-10-15T00:00:00.000Z', retryCount: 0, lineMessage: {},
    }]));
    const pageCursors: Array<string | null> = [];
    let releaseFirstPage!: () => void;
    let firstPageStarted!: () => void;
    const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
    const firstPageEntered = new Promise<void>((resolve) => { firstPageStarted = resolve; });
    const messages = {
      async recoverAttachmentPage(afterAccountId: string | null, limit: number) {
        pageCursors.push(afterAccountId);
        if (pageCursors.length === 1) { firstPageStarted(); await firstPageGate; }
        const pending = [...rows.values()].filter((row) => row.status === 'queued' && (afterAccountId === null || row.accountId > afterAccountId));
        const items = pending.slice(0, Math.min(2, limit)).map((row) => ({ accountId: row.accountId, attachmentId: row.attachmentId }));
        return { items, hasMore: false };
      },
      async getAttachment(id: string) { return [...rows.values()].find((row) => row.attachmentId === id) ?? null; },
      async claimAttachmentDownload() { return 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1'; },
      async markAttachmentReady(mutation: { attachmentId: string }) {
        const row = [...rows.values()].find((candidate) => candidate.attachmentId === mutation.attachmentId);
        if (!row) return false;
        row.status = 'ready';
        return true;
      },
      async recoverAttachments() { return []; }, async revokeAttachmentOwner() {},
    } as unknown as MessageRepository;
    const downloaded: string[] = [];
    const service = new AttachmentService(messages, {
      async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(command) {
        downloaded.push(command.accountId);
        return { type: 'attachmentResult' as const, status: 'ready' as const, accountId: command.accountId,
          chatType: command.chatType, chatId: command.chatId, attachmentId: command.attachmentId,
          attemptToken: command.attemptToken, workerInstanceId: command.workerInstanceId,
          relativePath: `managed/${command.accountId}.blob`, sha256: 'b'.repeat(64), sizeBytes: 1, name: command.accountId };
      },
    }, undefined, 1);
    withoutGap(service);
    try {
      await service.recover();
      await firstPageEntered;
      const directRequests = Array.from({ length: 256 }, (_, index) => service.downloadById(`terminal-unavailable-${index}`));
      expect((service as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(256);
      releaseFirstPage();
      await Promise.all(directRequests);
      await vi.waitFor(() => expect(pageCursors).toHaveLength(2), { timeout: 500 });
      await vi.waitFor(() => expect(downloaded).toEqual(['a', 'b']), { timeout: 5_000 });
      expect(pageCursors.slice(0, 2)).toEqual([null, null]);
    } finally {
      releaseFirstPage();
      await service.shutdown();
    }
  });

  it('continues scoped recovery after the first account has no attachments', async () => {
    let firstStarted!: () => void;
    const emptyStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const attachment = { attachmentId: 'queued-second', externalAttachmentId: 'external', accountId: 'second', chatType: 'group' as const,
      chatId: 'chat', messageId: 'message', kind: 'file' as const, name: 'x', mimeType: null, status: 'queued' as 'queued' | 'ready',
      relativePath: null, sha256: null, sizeBytes: null, error: null, occurredAt: '2026-10-15T00:00:00.000Z', retryCount: 0, lineMessage: {} };
    let ready = false;
    const messages = {
      async recoverAttachments(accountId: string) {
        if (accountId === 'empty') { firstStarted(); await firstGate; return []; }
        return accountId === 'second' ? [attachment.attachmentId] : [];
      },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; },
      async getAttachment(id: string) { return id === attachment.attachmentId ? attachment : null; },
      async claimAttachmentDownload() { return 'attempt-token'; },
      async markAttachmentReady() { ready = true; attachment.status = 'ready'; return true; }, async revokeAttachmentOwner() {},
    } as unknown as MessageRepository;
    let downloads = 0;
    const service = new AttachmentService(messages, {
      async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(command) { downloads += 1; return { type: 'attachmentResult', accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, chatType: command.chatType, chatId: command.chatId,
        attachmentId: command.attachmentId, attemptToken: command.attemptToken, status: 'ready',
        relativePath: 'managed/queued.blob', sha256: 'a'.repeat(64), sizeBytes: 1, name: 'queued' }; },
    });
    try {
      await service.recover('empty');
      await emptyStarted;
      await service.recover('second');
      releaseFirst();
      await vi.waitFor(() => expect(downloads).toBe(1), { timeout: 1_000 });
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 1_000 });
    } finally {
      releaseFirst();
      await service.shutdown();
    }
  });

  it('preserves scoped recovery requests received while a terminal global page is pending', async () => {
    let globalStarted!: () => void;
    const started = new Promise<void>((resolve) => { globalStarted = resolve; });
    let releaseGlobal!: () => void;
    const globalGate = new Promise<void>((resolve) => { releaseGlobal = resolve; });
    const attachment = { attachmentId: 'concurrent-second', externalAttachmentId: 'external', accountId: 'second', chatType: 'group' as const,
      chatId: 'chat', messageId: 'message', kind: 'file' as const, name: 'x', mimeType: null, status: 'queued' as 'queued' | 'ready',
      relativePath: null, sha256: null, sizeBytes: null, error: null, occurredAt: '2026-10-15T00:00:00.000Z', retryCount: 0, lineMessage: {} };
    let ready = false;
    let scopedScans = 0;
    let globalScans = 0;
    const messages = {
      async recoverAttachmentPage() {
        globalScans += 1;
        if (globalScans === 1) { globalStarted(); await globalGate; }
        return { items: [], hasMore: false };
      },
      async recoverAttachments(accountId: string) { scopedScans += 1; return accountId === 'second' && attachment.status === 'queued' ? [attachment.attachmentId] : []; },
      async getAttachment(id: string) { return id === attachment.attachmentId ? attachment : null; },
      async claimAttachmentDownload() { return 'attempt-token'; },
      async markAttachmentReady() { ready = true; attachment.status = 'ready'; return true; }, async revokeAttachmentOwner() {},
    } as unknown as MessageRepository;
    const service = new AttachmentService(messages, {
      async binding(accountId) { return { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download(command) { return { type: 'attachmentResult', accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, chatType: command.chatType, chatId: command.chatId,
        attachmentId: command.attachmentId, attemptToken: command.attemptToken, status: 'ready',
        relativePath: 'managed/concurrent.blob', sha256: 'a'.repeat(64), sizeBytes: 1, name: 'concurrent' }; },
    });
    try {
      await service.recover();
      await started;
      await service.recover('second');
      releaseGlobal();
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 1_000 });
      expect(scopedScans).toBe(2);
    } finally {
      releaseGlobal();
      await service.shutdown();
    }
  });

  it('surfaces owner revocation failure from shutdown', async () => {
    const failing = { async revokeAttachmentOwner() { throw new Error('owner revocation failed'); } } as unknown as MessageRepository;
    const service = new AttachmentService(failing, { async binding() { return null; }, async isReady() { return false; }, async download() { throw new Error('unused'); } });
    await expect(service.shutdown()).rejects.toThrow('owner revocation failed');
  });

  it('owns and backs off rejected recovery scans without a microtask retry loop', async () => {
    let scans = 0;
    const reported: unknown[] = [];
    const failing = { async recoverAttachmentPage() { scans += 1; throw new Error('scan unavailable'); }, async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(failing, { async binding() { return null; }, async isReady() { return false; }, async download() { throw new Error('unused'); } },
      undefined, 1, undefined, (error) => reported.push(error));
    await service.recover();
    await Promise.resolve(); await Promise.resolve();
    expect(scans).toBe(1);
    expect(reported).toHaveLength(1);
    expect((service as unknown as { retryTimer: ReturnType<typeof setTimeout> | null }).retryTimer).not.toBeNull();
    await service.shutdown();
    expect((service as unknown as { retryTimer: ReturnType<typeof setTimeout> | null }).retryTimer).toBeNull();
  });

  it('bounds a claim waiting on an attachment row lock and leaves it queued after shutdown', async () => {
    await messages.ingestAndRoute({ eventId: 'shutdown-row-lock', accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'u', messageId: 'shutdown-row-lock',
      kind: 'file', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
      attachments: [{ id: 'shutdown-row-lock', kind: 'file', name: 'locked', mimeType: null, sizeBytes: null }] }, { eligible: false });
    const id = (await messages.getAttachmentBySource({ accountId: 'a', chatType: 'group', chatId: 'g' }, 'shutdown-row-lock', 'shutdown-row-lock'))!.attachmentId;
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT attachment_id FROM attachments WHERE attachment_id = $1 FOR UPDATE', [id]);
    let bindingStarted!: () => void;
    const bindingRead = new Promise<void>((resolve) => { bindingStarted = resolve; });
    let workerCalls = 0;
    const service = new AttachmentService(messages, {
      async binding() { bindingStarted(); return { accountId: 'a', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }; },
      async isReady() { return true; },
      async download() { workerCalls++; throw new Error('must not start after shutdown'); },
    });
    const task = service.downloadById(id);
    try {
      await bindingRead;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.shutdown();
      await lock.query('ROLLBACK');
      await task;
      expect(workerCalls).toBe(0);
      expect(await messages.getAttachment(id)).toMatchObject({ status: 'queued' });
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
      await service.shutdown();
    }
  });
});

describe('AttachmentService random gap between automatic downloads', () => {
  function harness(random: () => number, options: { bound?: boolean; manualIds?: string[] } = {}) {
    const rows = new Map<string, ReturnType<typeof queuedAttachment>>();
    const sent: string[] = [];
    let active = 0; let maximumActive = 0; let releaseGate: (() => void) | null = null;
    let gateFirst = false;
    const repository = { async getAttachment(id: string) { return rows.get(id) ?? null; },
      async claimAttachmentDownload() { return randomUUID(); },
      async markAttachmentReady(mutation: { attachmentId: string }) { rows.get(mutation.attachmentId)!.status = 'ready' as never; return true; },
      async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding(accountId) {
      return options.bound === false ? null : { accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    }, async isReady() { return true; }, async download(command) {
      sent.push(command.attachmentId); active += 1; maximumActive = Math.max(maximumActive, active);
      if (gateFirst && sent.length === 1) await new Promise<void>((resolve) => { releaseGate = resolve; });
      active -= 1;
      return readyAttachmentResult(command);
    } }, undefined, 4, undefined, undefined, undefined, undefined, random);
    const add = (id: string, overrides: Record<string, unknown> = {}) => { rows.set(id, queuedAttachment(id, undefined, overrides)); };
    return { service, rows, sent, add, maximumActive: () => maximumActive,
      holdFirst: () => { gateFirst = true; }, release: () => releaseGate?.() };
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([[0, 3_000], [0.999999, 10_000]])('spaces the next automatic download by the gap for random %s', async (value, gap) => {
    expect(ATTACHMENT_GAP_MIN_MS).toBe(3_000); expect(ATTACHMENT_GAP_MAX_MS).toBe(10_000);
    const h = harness(() => value);
    h.add('one'); h.add('two');
    const first = h.service.downloadById('one');
    const second = h.service.downloadById('two');
    try {
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toBe(true);
      expect(h.sent).toEqual(['one']);
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(h.sent).toEqual(['one']);
      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toBe(true);
      expect(h.sent).toEqual(['one', 'two']);
    } finally { await h.service.shutdown(); }
  });

  it('never sends a second command while one is in flight', async () => {
    const h = harness(() => 0);
    h.holdFirst(); h.add('one'); h.add('two');
    const first = h.service.downloadById('one');
    const second = h.service.downloadById('two');
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sent).toEqual(['one']);
      h.release();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(h.maximumActive()).toBe(1);
    } finally { h.release(); await h.service.shutdown(); }
  });

  it('starts a manual download inside a pending gap and spaces the next automatic one from it', async () => {
    const h = harness(() => 0);
    h.add('auto-one'); h.add('manual', { status: 'expired' }); h.add('auto-two');
    const first = h.service.downloadById('auto-one');
    try {
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toBe(true);
      const auto = h.service.downloadById('auto-two');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sent).toEqual(['auto-one']);
      const manual = h.service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, 'manual');
      await vi.advanceTimersByTimeAsync(0);
      await expect(manual).resolves.toBe(true);
      expect(h.sent).toEqual(['auto-one', 'manual']);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(h.sent).toEqual(['auto-one', 'manual']);
      await vi.advanceTimersByTimeAsync(1);
      await expect(auto).resolves.toBe(true);
      expect(h.sent).toEqual(['auto-one', 'manual', 'auto-two']);
    } finally { await h.service.shutdown(); }
  });

  it('adds no gap when the attempt ends before contacting the worker', async () => {
    const h = harness(() => 0.5, { bound: false });
    h.add('unbound');
    try {
      await expect(h.service.downloadById('unbound')).resolves.toBe(false);
      expect((h.service as unknown as { nextAutomaticAt: number }).nextAutomaticAt).toBe(0);
      expect(h.sent).toEqual([]);
    } finally { await h.service.shutdown(); }
  });

  it('leaves no timer and sends nothing after shutdown with a pending gap', async () => {
    const h = harness(() => 0);
    h.add('one'); h.add('two');
    const first = h.service.downloadById('one');
    const second = h.service.downloadById('two');
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await h.service.shutdown();
    await expect(second).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent).toEqual(['one']);
  });
});
