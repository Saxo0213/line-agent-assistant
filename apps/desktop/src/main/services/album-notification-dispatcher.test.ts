import { describe, expect, it, vi } from 'vitest';
import { AlbumNotificationDispatcher, archiveAlbumContinuations } from './album-notification-dispatcher.js';
import type { AlbumOpenResult, ChatResourceBinding } from './chat-resources.js';
import type { ConversationKey } from '@line-agent/contracts';

const binding: ChatResourceBinding = { accountId: 'agent', workerInstanceId: 'worker', controlEpoch: 1,
  transportOwnerId: 'owner', transportGeneration: 1, writeGrantVersion: 1, mode: 'ACTIVE_CONTROL' };
const key = (chatId: string) => ({ accountId: 'agent', chatType: 'group' as const, chatId });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AlbumNotificationDispatcher', () => {
  it('keeps earlier chunk failures retryable even when the final continuation completes', async () => {
    const results: AlbumOpenResult[] = [
      { albumId: 'album', savedCount: 4, failedCount: 1, totalCount: 5, byteCount: 10, complete: false,
        failureCodes: ['NETWORK_ERROR'], errorCode: 'BYTE_LIMIT', nextCursor: 'page-2', nextPhotoIndex: 0 },
      { albumId: 'album', savedCount: 5, failedCount: 0, totalCount: 5, byteCount: 10, complete: true,
        failureCodes: [], errorCode: null, nextCursor: null, nextPhotoIndex: 0 },
    ];
    const openSegment = vi.fn(async () => results.shift()!);
    await expect(archiveAlbumContinuations(openSegment)).rejects.toThrow('ALBUM_PHOTO_SAVE_INCOMPLETE');
    expect(openSegment).toHaveBeenCalledTimes(2);
  });

  it('retries an incomplete continuation without another notification', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const scan = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          const segments: AlbumOpenResult[] = [
            { albumId: 'album', savedCount: 549, failedCount: 1, totalCount: 550, byteCount: 10, complete: false,
              failureCodes: ['NETWORK_ERROR'], errorCode: 'PAGE_LIMIT', nextCursor: 'page-2', nextPhotoIndex: 0 },
            { albumId: 'album', savedCount: 50, failedCount: 0, totalCount: 50, byteCount: 10, complete: true,
              failureCodes: [], errorCode: null, nextCursor: null, nextPhotoIndex: 0 },
          ];
          await archiveAlbumContinuations(async () => segments.shift()!);
        }
      });
      const dispatcher = new AlbumNotificationDispatcher(scan, async () => binding);
      dispatcher.request(key('first'), binding);
      await vi.advanceTimersByTimeAsync(0);
      expect(scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(scan).toHaveBeenCalledTimes(2);
      await dispatcher.shutdown();
    } finally { vi.useRealTimers(); }
  });

  it('keeps retry cooldown when new notifications arrive after a failed scan', async () => {
    vi.useFakeTimers();
    try {
      const scans: Array<string | null> = [];
      const scan = vi.fn(async (_accountId: string, _binding: ChatResourceBinding, target: ConversationKey | null) => {
        scans.push(target?.chatId ?? null);
        if (scans.length === 1) throw new Error('temporary LINE failure');
      });
      const dispatcher = new AlbumNotificationDispatcher(scan, async () => binding);
      dispatcher.request(key('first'), binding);
      await vi.advanceTimersByTimeAsync(0);
      expect(scans).toEqual(['first']);

      dispatcher.request(key('second'), binding);
      dispatcher.request(key('third'), binding);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(scans).toEqual(['first']);

      await vi.advanceTimersByTimeAsync(1);
      expect(scans).toEqual(['first', null]);
      await dispatcher.shutdown();
    } finally { vi.useRealTimers(); }
  });

  it('does not let a dirty failed flight handoff bypass the scheduled retry', async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst!: (error: Error) => void;
      const firstScan = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      const scans: Array<string | null> = [];
      const scan = vi.fn(async (_accountId: string, _binding: ChatResourceBinding, target: ConversationKey | null) => {
        scans.push(target?.chatId ?? null);
        if (scans.length === 1) await firstScan;
      });
      const dispatcher = new AlbumNotificationDispatcher(scan, async () => binding);
      dispatcher.request(key('first'), binding);
      await vi.advanceTimersByTimeAsync(0);
      dispatcher.request(key('second'), binding);
      rejectFirst(new Error('temporary LINE failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(scans).toEqual(['first']);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(scans).toEqual(['first', null]);
      await dispatcher.shutdown();
    } finally { vi.useRealTimers(); }
  });

  it('coalesces same chat arrivals into one trailing refresh and sweeps different chats without pending growth', async () => {
    const started = deferred();
    const release = deferred();
    const scans: Array<string | null> = [];
    const scan = vi.fn(async (_accountId: string, _binding: ChatResourceBinding, target: ConversationKey | null) => {
      scans.push(target?.chatId ?? null);
      if (scans.length === 1) { started.resolve(); await release.promise; }
    });
    const dispatcher = new AlbumNotificationDispatcher(scan, async () => binding);
    dispatcher.request(key('first'), binding);
    await started.promise;
    dispatcher.request(key('first'), binding);
    dispatcher.request(key('second'), binding);
    dispatcher.request(key('third'), binding);
    release.resolve();
    await vi.waitFor(() => expect(scans).toEqual(['first', null]));
    await dispatcher.shutdown();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('recovers committed demand through a sweep after startup', async () => {
    const scan = vi.fn(async () => {});
    const dispatcher = new AlbumNotificationDispatcher(scan, async () => binding);
    dispatcher.recover(binding.accountId, binding);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledWith(binding.accountId, binding, null,
      { sweep: true, recover: true, backfill: true }));
    await dispatcher.shutdown();
  });

  it('does not schedule a retry wake after shutdown while an in-flight scan resolves', async () => {
    vi.useFakeTimers();
    try {
      const started = deferred();
      const release = deferred();
      const scan = vi.fn(async () => { started.resolve(); await release.promise; return Date.now() + 60_000; });
      const dispatcher = new AlbumNotificationDispatcher(scan, async () => binding);
      dispatcher.request(key('first'), binding);
      await vi.advanceTimersByTimeAsync(0);
      await started.promise;
      const shutdown = dispatcher.shutdown();
      release.resolve();
      await shutdown;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
