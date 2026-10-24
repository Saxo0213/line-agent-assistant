import { describe, expect, it } from 'vitest';
import { IpcRequestSchema, IpcResultSchema } from './ipc.js';

describe('chat resource IPC contracts', () => {
  const base = { accountId: 'account-1', chatType: 'group', chatId: 'chat-1', requestId: 'request-1' } as const;

  it('accepts bounded paginated Note and Album reads', () => {
    expect(IpcRequestSchema.safeParse({ type: 'listChatNotes', ...base, cursor: null }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'listChatAlbums', ...base, cursor: 'cursor' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'listChatAlbumPhotos', ...base, albumId: 'album-1', cursor: null }).success).toBe(true);
  });

  it('accepts request-scoped cancellation messages and acknowledgments', () => {
    expect(IpcRequestSchema.safeParse({ type: 'cancelChatResourceRequest', requestId: 'cancel-1', targetRequestId: 'request-1' }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'cancelChatResourceRequest', requestId: 'cancel-1', ok: true, cancelled: true }).success).toBe(true);
  });

  it('requires photo identity and an allowed LINE album prefix to download', () => {
    expect(IpcRequestSchema.safeParse({ type: 'downloadChatAlbumPhoto', ...base, albumId: 'album-1', photoId: 'photo-1', oid: 'oid', prefix: 'album/a' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'downloadChatAlbumPhoto', ...base, albumId: 'album-1', photoId: 'photo-1', oid: 'oid', prefix: 'https://example.test' }).success).toBe(false);
  });

  it('accepts explicit album open requests and bounded partial results', () => {
    expect(IpcRequestSchema.safeParse({ type: 'openChatAlbum', ...base, albumId: 'album-1' }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'openChatAlbum', requestId: base.requestId, ok: true, albumId: 'album-1',
      savedCount: 1, failedCount: 1, totalCount: 2, byteCount: 4096, complete: false, failureCodes: ['LINE_READ_FAILED'], errorCode: null }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'openChatAlbum', requestId: base.requestId, ok: true, albumId: 'album-1',
      savedCount: 1, failedCount: 1, totalCount: 2, byteCount: 4096, complete: false, failureCodes: [], errorCode: null,
      failureContext: { action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' } }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'openChatAlbum', requestId: base.requestId, ok: true, albumId: 'album-1',
      savedCount: 1, failedCount: 1, totalCount: 2, byteCount: 4096, complete: false, failureCodes: [], errorCode: null,
      failureContext: { action: 'photo_download', stage: 'resource_read', code: 'EFFECT_DENIED', rawError: 'secret' } }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'openChatAlbum', requestId: base.requestId, ok: true, albumId: 'album-1',
      savedCount: 501, failedCount: 0, totalCount: 501, byteCount: 0, complete: true, failureCodes: [], errorCode: null }).success).toBe(false);
  });

  it('accepts readable album folder actions without accepting renderer paths', () => {
    expect(IpcRequestSchema.safeParse({ type: 'openReadableChatAlbumFolder', ...base, albumId: 'album-1' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'openReadableChatAlbumFolder', ...base, albumId: 'album-1', path: 'C:\\private' }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'openReadableChatAlbumFolder', requestId: base.requestId, ok: true, albumId: 'album-1',
      exportedCount: 1, failedCount: 1, totalCount: 2, complete: false, failureCodes: ['NO_REPLACE_CONFLICT'], folderName: 'Trip__0123456789', opened: true }).success).toBe(true);
  });

  it('accepts only bounded display DTOs and download metadata', () => {
    expect(IpcResultSchema.safeParse({ type: 'listChatNotes', requestId: 'request-1', ok: true, notes: [
      { postId: 'post-1', createdTime: null, text: null, content: { value: 'plain data' } },
    ], nextCursor: null }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'downloadChatAlbumPhoto', requestId: 'request-1', albumId: 'album-1', photoId: 'photo-1', ok: true, sizeBytes: 1 }).success).toBe(true);
  });
});
