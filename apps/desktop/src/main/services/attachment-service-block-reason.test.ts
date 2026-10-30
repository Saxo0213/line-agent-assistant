import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AttachmentBlockReason, AttachmentResult, LineWorkerCommand } from '@line-agent/contracts';
import type { MessageRepository } from '../../../../../packages/database/src/index.js';
import type { Attachment } from '../../../../../packages/database/src/message-repository.js';
import { AttachmentService } from './attachment-service.js';

function row(id: string, overrides: Record<string, unknown> = {}): Attachment {
  return { attachmentId: id, externalAttachmentId: `external-${id}`, accountId: 'a', chatType: 'group', chatId: 'g',
    messageId: `message-${id}`, kind: 'file', name: `${id}.bin`, mimeType: null, status: 'queued', relativePath: null,
    sha256: null, sizeBytes: null, error: null, occurredAt: new Date(Date.now() - 60_000).toISOString(), retryCount: 0,
    retryAfter: null, createdAt: new Date(Date.now() - 11_000).toISOString(), expiresAt: null, updatedAt: new Date().toISOString(),
    lineMessage: {}, externalSource: false, ...overrides } as Attachment;
}

type Binding = { accountId: string; workerInstanceId: string; controlEpoch: number; mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' };

function harness(attachment: Attachment, options: { binding: (accountId: string) => Binding | null; ready?: boolean }) {
  const writes: Array<[string, AttachmentBlockReason]> = [];
  const audits: Array<[string, AttachmentBlockReason]> = [];
  const claims: string[] = [];
  const repository = {
    async getAttachment() { return attachment; },
    async setAttachmentBlockReason(attachmentId: string, reason: AttachmentBlockReason) {
      if (attachment.status !== 'queued' || attachment.error === reason) return false;
      attachment.error = reason; writes.push([attachmentId, reason]); return true;
    },
    async claimAttachmentDownload() { claims.push(attachment.attachmentId); attachment.error = null; attachment.status = 'downloading' as never; return randomUUID(); },
    async markAttachmentReady() { attachment.status = 'ready' as never; return true; },
    async recoverAttachmentPage() { return { items: [], hasMore: false }; }, async recoverAttachments() { return []; },
    async revokeAttachmentOwner() {},
  } as unknown as MessageRepository;
  const download = vi.fn(async (command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>): Promise<AttachmentResult> => ({
    type: 'attachmentResult', accountId: command.accountId, chatType: command.chatType, chatId: command.chatId,
    workerInstanceId: command.workerInstanceId, attachmentId: command.attachmentId, attemptToken: command.attemptToken,
    status: 'ready', relativePath: `managed/${command.attachmentId}.bin`, sha256: 'a'.repeat(64), sizeBytes: 1, name: 'ready.bin' }));
  const changed: string[] = [];
  const service = new AttachmentService(repository, {
    async binding(accountId) { return options.binding(accountId); },
    async isReady() { return options.ready ?? true; },
    download,
  }, undefined, 4, (id) => { changed.push(id); }, undefined, undefined, undefined, () => 0, undefined,
  (accountId, reason) => audits.push([accountId, reason]));
  (service as unknown as { randomGapMs(): number }).randomGapMs = () => 0;
  return { service, writes, audits, claims, download, changed };
}

const active = (accountId: string): Binding => ({ accountId, workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });

describe('AttachmentService block reasons', () => {
  it('keeps ATTACHMENT_WORKER_UNAVAILABLE when the account has no worker, and writes it and the audit once', async () => {
    const attachment = row('no-worker');
    const h = harness(attachment, { binding: () => null });
    try {
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      expect(h.writes).toEqual([[attachment.attachmentId, 'ATTACHMENT_WORKER_UNAVAILABLE']]);
      expect(h.audits).toEqual([['a', 'ATTACHMENT_WORKER_UNAVAILABLE']]);
      expect(h.claims).toEqual([]);
      expect(h.download).not.toHaveBeenCalled();
      expect(attachment).toMatchObject({ status: 'queued', error: 'ATTACHMENT_WORKER_UNAVAILABLE', retryCount: 0 });
      expect(h.changed).toEqual([attachment.attachmentId]);
    } finally { await h.service.shutdown(); }
  });

  it('keeps ATTACHMENT_WORKER_NOT_READY when the worker is PAUSED', async () => {
    const attachment = row('paused');
    const h = harness(attachment, { binding: (accountId) => ({ ...active(accountId), mode: 'PAUSED' }) });
    try {
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      expect(h.writes).toEqual([[attachment.attachmentId, 'ATTACHMENT_WORKER_NOT_READY']]);
      expect(h.audits).toEqual([['a', 'ATTACHMENT_WORKER_NOT_READY']]);
      expect(h.claims).toEqual([]);
    } finally { await h.service.shutdown(); }
  });

  it('keeps ATTACHMENT_WORKER_NOT_READY when the worker is not ready, and audits each reason change of the account once', async () => {
    const attachment = row('not-ready');
    let binding: Binding | null = active('a');
    let ready = false;
    const h = harness(attachment, { binding: () => binding });
    (h.service as unknown as { worker: { isReady(): Promise<boolean> } }).worker.isReady = async () => ready;
    try {
      await h.service.downloadById(attachment.attachmentId);
      await h.service.downloadById(attachment.attachmentId);
      expect(h.writes).toEqual([[attachment.attachmentId, 'ATTACHMENT_WORKER_NOT_READY']]);
      expect(h.audits).toEqual([['a', 'ATTACHMENT_WORKER_NOT_READY']]);
      binding = null;
      await h.service.downloadById(attachment.attachmentId);
      expect(h.audits).toEqual([['a', 'ATTACHMENT_WORKER_NOT_READY'], ['a', 'ATTACHMENT_WORKER_UNAVAILABLE']]);
      expect(attachment.error).toBe('ATTACHMENT_WORKER_UNAVAILABLE');
      // The worker is ready again: the claim clears the row reason and the account audit state is reset.
      binding = active('a'); ready = true;
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(true);
      expect(attachment).toMatchObject({ status: 'ready', error: null });
      expect(h.claims).toEqual([attachment.attachmentId]);
    } finally { await h.service.shutdown(); }
  });

  it('keeps EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE for an External Monitor row and never claims it automatically', async () => {
    const attachment = row('external', { externalSource: true });
    const h = harness(attachment, { binding: (accountId) => active(accountId) });
    try {
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      expect(h.writes).toEqual([[attachment.attachmentId, 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE']]);
      expect(h.audits).toEqual([['a', 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE']]);
      expect(h.claims).toEqual([]);
      expect(h.download).not.toHaveBeenCalled();
    } finally { await h.service.shutdown(); }
  });

  it('keeps the External Monitor reason on the row when a manual attempt finds no worker', async () => {
    const attachment = row('external-manual', { externalSource: true, error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' });
    const h = harness(attachment, { binding: () => null });
    try {
      await expect(h.service.downloadManually({ accountId: 'a', chatType: 'group', chatId: 'g' }, attachment.attachmentId)).resolves.toBe(false);
      expect(h.writes).toEqual([]);
      expect(attachment.error).toBe('EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE');
      expect(h.audits).toEqual([['a', 'ATTACHMENT_WORKER_UNAVAILABLE']]);
    } finally { await h.service.shutdown(); }
  });

  it('does not change the real error of a failed row that waits for a worker', async () => {
    const attachment = row('failed-row', { status: 'failed', retryCount: 1, error: 'LINE_NATIVE_DOWNLOAD_FAILED',
      retryAfter: new Date(Date.now() - 1_000).toISOString() });
    const h = harness(attachment, { binding: () => null });
    try {
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      expect(h.writes).toEqual([]);
      expect(attachment).toMatchObject({ status: 'failed', error: 'LINE_NATIVE_DOWNLOAD_FAILED', retryCount: 1 });
    } finally { await h.service.shutdown(); }
  });

  it('does not let a failed reason write or audit change the download result', async () => {
    const attachment = row('write-fails');
    const h = harness(attachment, { binding: () => null });
    (h.service as unknown as { messages: { setAttachmentBlockReason(): Promise<boolean> } }).messages.setAttachmentBlockReason = async () => { throw new Error('db down'); };
    try {
      await expect(h.service.downloadById(attachment.attachmentId)).resolves.toBe(false);
      expect(h.audits).toEqual([['a', 'ATTACHMENT_WORKER_UNAVAILABLE']]);
    } finally { await h.service.shutdown(); }
  });

  it('backfills External Monitor reasons in bounded passes', async () => {
    const counts = [1000, 1000, 7];
    const calls: number[] = [];
    const repository = { async backfillExternalAttachmentBlockReasons(limit: number) { calls.push(limit); return counts.shift() ?? 0; },
      async revokeAttachmentOwner() {} } as unknown as MessageRepository;
    const service = new AttachmentService(repository, { async binding() { return null; }, async isReady() { return false; }, download: vi.fn() });
    try {
      await service.backfillBlockReasons();
      expect(calls).toEqual([1000, 1000, 1000]);
    } finally { await service.shutdown(); }
  });
});
