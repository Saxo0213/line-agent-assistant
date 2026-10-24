import { expect, it, vi } from 'vitest';
import { LineWorkerLoop } from './worker-loop.js';
import { FakeLineTransport } from './fake-transport.js';

const binding = { accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 7 };
const chatId = `c${'a'.repeat(32)}`;
const otherChatId = `c${'b'.repeat(32)}`;
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
function setup() {
  const transport = new FakeLineTransport({ ownMid: `u${'a'.repeat(32)}`, displayName: 'Fixture' });
  const events: unknown[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => true });
  return { worker, transport, events };
}
async function ready(worker: LineWorkerLoop) {
  await worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
}

it('filters account-wide album responses to the exact selected chat before emitting', async () => {
  const { worker, transport, events } = setup();
  await ready(worker);
  transport.enqueueChatResource({ albums: [
    { albumId: 'visible', chatId, title: 'Selected', photoCount: 1, createTime: 1, updateTime: 2 },
    { albumId: 'other', chatId: otherChatId, title: 'Other', photoCount: 1, createTime: 1, updateTime: 2 },
  ], nextCursor: 'page-2' });
  await worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'albums-1', action: 'listAlbums', limit: 10, timeoutMs: 10_000 });
  expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', ok: true, albums: [{ albumId: 'visible', chatId }], nextCursor: 'page-2' });
});

it('passes bounded photo-page shape through the existing worker result', async () => {
  const { worker, transport, events } = setup();
  await ready(worker);
  const photoPageShape = { rawPhotoCount: 0, hasMorePresent: false as const, nextCursorRelation: 'same' as const };
  transport.enqueueChatResource({ photos: [], nextCursor: 'opaque-native-cursor', photoPageShape });
  await worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'photos-shape',
    action: 'listAlbumPhotos', albumId: 'album-1', cursor: 'opaque-native-cursor', timeoutMs: 10_000 });
  expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', ok: true, photos: [], photoPageShape });
  expect(JSON.stringify((events.at(-1) as { photoPageShape: unknown }).photoPageShape)).not.toContain('opaque-native-cursor');
});

it('rejects malformed LINE metadata and oversized image data without emitting it', async () => {
  const { worker, transport, events } = setup();
  await ready(worker);
  transport.enqueueChatResource({ albums: [{ albumId: 'bad', chatId, title: 'x'.repeat(513), photoCount: 1, createTime: 1, updateTime: 1 }] });
  await worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'bad-album', action: 'listAlbums', timeoutMs: 10_000 });
  expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', ok: false, error: 'response_validation' });
  transport.enqueueChatResource({ bytes: new Uint8Array(20 * 1024 * 1024 + 1) });
  await worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'big-photo', action: 'downloadAlbumPhoto',
    albumId: 'album-1', photoId: 'photo-1', oid: 'oid-1', prefix: 'album/a', maxBytes: 20 * 1024 * 1024, timeoutMs: 10_000 });
  expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', ok: false, error: 'response_validation' });
});

it('cancels a pending read when the matching request is cancelled', async () => {
  const { worker, transport, events } = setup();
  await ready(worker);
  let seenSignal: AbortSignal | undefined;
  transport.readChatResource = async (_command, options) => {
    seenSignal = options.signal;
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const read = worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'cancel-me', action: 'listNotes', timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await worker.handle({ type: 'cancelChatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'cancel-me' });
  await read;
  expect(seenSignal?.aborted).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', requestId: 'cancel-me', ok: false, error: 'CANCELLED' });
});

it('rejects reads after pause, stop, or revoke before calling LINE transport', async () => {
  const paused = setup();
  await paused.worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'PAUSED', durableCursor: cursor });
  await paused.worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'paused', action: 'listNotes', timeoutMs: 10_000 });
  expect(paused.transport.chatResourceCalls).toHaveLength(0);
  expect(paused.events.at(-1)).toMatchObject({ type: 'chatResourceResult', error: 'WORKER_NOT_ACTIVE' });

  for (const type of ['stop', 'revokeControl'] as const) {
    const h = setup();
    await ready(h.worker);
    await h.worker.handle({ type, ...binding });
    await h.worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: type,
      action: 'listNotes', timeoutMs: 10_000 });
    expect(h.transport.chatResourceCalls).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ type: 'chatResourceResult', error: 'WORKER_NOT_ACTIVE' });
  }
});

it('times out a stalled read and reuses its worker slot for the next request', async () => {
  vi.useFakeTimers();
  try {
    const { worker, transport, events } = setup();
    await ready(worker);
    let calls = 0;
    transport.readChatResource = async (_command, options) => {
      calls += 1;
      if (calls === 1) return await new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      return { notes: [{ postId: 'after-timeout', createdTime: 2, text: 'ok' }], nextCursor: null };
    };
    const first = worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'stalled',
      action: 'listNotes', timeoutMs: 1_000 });
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', requestId: 'stalled', error: 'TIMEOUT' });
    await worker.handle({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId, requestId: 'retry',
      action: 'listNotes', timeoutMs: 1_000 });
    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', requestId: 'retry', ok: true });
  } finally { vi.useRealTimers(); }
});
