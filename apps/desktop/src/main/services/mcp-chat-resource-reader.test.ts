import { describe, expect, it, vi } from 'vitest';
import { chatResourcePhotoId, chatResourcePhotoPageId } from './chat-resources.js';
import { createMcpChatResourceArchiveReader, type ArchivedChatResourceSource } from './mcp-chat-resource-reader.js';

const key = { accountId: 'account-a', chatType: 'group' as const, chatId: 'group-a' };
const savedAt = '2026-10-23T12:00:00.000Z';
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('MCP chat resource archive reader', () => {
  it('projects saved notes and their revision timestamp from local records', async () => {
    const source: ArchivedChatResourceSource = {
      listArchived: vi.fn(async () => ({ items: [{ resourceId: 'post-a', revision: 3, savedAt, contentHash: 'a'.repeat(64), byteLength: 4 }], nextCursor: null })),
      readArchived: vi.fn(async (_key, _kind, id) => id === 'post-a' ? { revision: 3, savedAt, content: Buffer.from('# Note post-a'), contentHash: 'b'.repeat(64), byteLength: 13 } : null),
    };
    const reader = createMcpChatResourceArchiveReader(source);
    await expect(reader.listNotes(key, 10)).resolves.toEqual({ notes: [{ noteId: 'post-a', savedAt }], nextCursor: null, savedAt });
    await expect(reader.getNote(key, 'post-a')).resolves.toEqual({ note: { noteId: 'post-a', markdown: '# Note post-a', savedAt }, savedAt });
    expect(source.readArchived).toHaveBeenCalledTimes(1);
  });

  it('projects album photos and checks image availability through archived records only', async () => {
    const album = { _linejsGenerated: 'album-v1', albumId: 'album-a', chatId: key.chatId, title: 'saved', photoCount: 1,
      createTime: 1, updateTime: 2 };
    const page = { _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor: null, nextCursor: null,
      photos: [{ photoId: 'photo-a', oid: 'oid-a', prefix: 'album/a', shotTime: 3, width: 10, height: 20 }] };
    const records = new Map<string, Uint8Array>([
      ['album-a', bytes(album)], [chatResourcePhotoPageId('album-a', null), bytes(page)],
      [chatResourcePhotoId('album-a', 'photo-a'), Buffer.from([1, 2, 3])],
    ]);
    const source: ArchivedChatResourceSource = {
      listArchived: vi.fn(async (_key, kind) => ({ items: kind === 'album'
        ? [{ resourceId: 'album-a', revision: 1, savedAt, contentHash: 'c'.repeat(64), byteLength: 1 }] : [], nextCursor: null })),
      readArchived: vi.fn(async (_key, _kind, id) => { const content = records.get(id); return content ? { revision: 1, savedAt, content, contentHash: 'd'.repeat(64), byteLength: content.byteLength } : null; }),
    };
    const reader = createMcpChatResourceArchiveReader(source);
    await expect(reader.listAlbums(key, 10)).resolves.toMatchObject({ albums: [{ albumId: 'album-a', title: 'saved', savedAt }] });
    await expect(reader.getAlbum(key, 'album-a')).resolves.toEqual({ album: { albumId: 'album-a', chatId: key.chatId, title: 'saved', photoCount: 1,
      createTime: 1, updateTime: 2 }, photos: [{ photoId: 'photo-a', shotTime: 3, width: 10, height: 20, available: true }], savedAt });
  });

  it('follows the current cursor chain, ignores disconnected pages, and deduplicates repeated photos', async () => {
    const makePage = (cursor: string | null, nextCursor: string | null, ids: string[]) => bytes({ _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor, nextCursor,
      photos: ids.map((photoId) => ({ photoId, shotTime: 1, width: 10, height: 20 })) });
    const page0 = chatResourcePhotoPageId('album-a', null), page1 = chatResourcePhotoPageId('album-a', 'cursor-a'), page2 = chatResourcePhotoPageId('album-a', 'cursor-b');
    const disconnected = chatResourcePhotoPageId('album-a', 'old-disconnected');
    const records = new Map<string, Uint8Array>([
      ['album-a', bytes({ _linejsGenerated: 'album-v1', albumId: 'album-a', chatId: key.chatId, title: 'saved' })],
      [page0, makePage(null, 'cursor-a', ['photo-a', 'photo-b'])], [page1, makePage('cursor-a', 'cursor-b', ['photo-b', 'photo-c'])],
      [page2, makePage('cursor-b', null, ['photo-d'])], [disconnected, makePage('old-disconnected', null, ['photo-old'])],
    ]);
    for (const id of ['photo-a', 'photo-b', 'photo-c', 'photo-d', 'photo-old']) records.set(chatResourcePhotoId('album-a', id), Buffer.from([1]));
    const requestedIds: string[] = [];
    const source: ArchivedChatResourceSource = {
      listArchived: vi.fn(async (_key, kind) => ({ items: kind === 'photo-page' ? Array.from({ length: 60 }, (_, index) => ({
        resourceId: `unrelated-${index}`, revision: 1, savedAt, contentHash: 'e'.repeat(64), byteLength: 1,
      })) : [], nextCursor: null })),
      readArchived: vi.fn(async (_key, _kind, id) => { requestedIds.push(id); const content = records.get(id); return content ? { revision: 2, savedAt, content, contentHash: 'd'.repeat(64), byteLength: content.byteLength } : null; }),
    };
    const result = await createMcpChatResourceArchiveReader(source).getAlbum(key, 'album-a');
    expect(result.photos.map((photo) => (photo as { photoId: string }).photoId)).toEqual(['photo-a', 'photo-b', 'photo-c', 'photo-d']);
    expect(requestedIds).toEqual(expect.arrayContaining([page0, page1, page2]));
    expect(requestedIds).not.toContain(disconnected);
    expect(source.listArchived).not.toHaveBeenCalled();
    const previousReadCount = requestedIds.length;
    records.set(page0, makePage(null, null, ['photo-a']));
    const shrunk = await createMcpChatResourceArchiveReader(source).getAlbum(key, 'album-a');
    expect(shrunk.photos.map((photo) => (photo as { photoId: string }).photoId)).toEqual(['photo-a']);
    expect(requestedIds.slice(previousReadCount)).not.toContain(page1);
  });

  it('stops cursor loops and honors a shrinking current chain without reading old pages', async () => {
    const page0 = chatResourcePhotoPageId('album-a', null), oldPage = chatResourcePhotoPageId('album-a', 'old');
    const records = new Map<string, Uint8Array>([
      ['album-a', bytes({ _linejsGenerated: 'album-v1', albumId: 'album-a', chatId: key.chatId })],
      [page0, bytes({ _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor: null, nextCursor: 'loop', photos: [] })],
      [chatResourcePhotoPageId('album-a', 'loop'), bytes({ _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor: 'loop', nextCursor: 'loop', photos: [] })],
      [oldPage, bytes({ _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor: 'old', nextCursor: null, photos: [{ photoId: 'historical' }] })],
    ]);
    const source: ArchivedChatResourceSource = {
      listArchived: vi.fn(async () => ({ items: [], nextCursor: null })),
      readArchived: vi.fn(async (_key, _kind, id) => { const content = records.get(id); return content ? { revision: 9, savedAt, content, contentHash: 'a'.repeat(64), byteLength: content.byteLength } : null; }),
    };
    const result = await createMcpChatResourceArchiveReader(source).getAlbum(key, 'album-a');
    expect(result.photos).toEqual([]);
    expect(source.readArchived).toHaveBeenCalledTimes(3);
    expect(source.listArchived).not.toHaveBeenCalled();
    expect(source.readArchived).not.toHaveBeenCalledWith(key, 'photo-page', oldPage, undefined);
  });

  it('continues to the next photo after a duplicate at the 50 unique photo boundary', async () => {
    const photoRows = (ids: string[]) => ids.map((photoId) => ({ photoId, shotTime: 1, width: 1, height: 1 }));
    const firstIds = Array.from({ length: 49 }, (_, index) => `photo-${index}`);
    const pages = new Map<string, Uint8Array>([
      ['album-a', bytes({ _linejsGenerated: 'album-v1', albumId: 'album-a', chatId: key.chatId })],
      [chatResourcePhotoPageId('album-a', null), bytes({ _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor: null, nextCursor: 'p2', photos: photoRows(firstIds) })],
      [chatResourcePhotoPageId('album-a', 'p2'), bytes({ _linejsGenerated: 'album-photos-v1', albumId: 'album-a', cursor: 'p2', nextCursor: null, photos: photoRows(['photo-0', 'photo-49']) })],
    ]);
    const source: ArchivedChatResourceSource = {
      listArchived: vi.fn(async () => ({ items: [], nextCursor: null })),
      readArchived: vi.fn(async (_key, _kind, id) => { const content = pages.get(id); return content ? { revision: 1, savedAt, content, contentHash: 'b'.repeat(64), byteLength: content.byteLength } : null; }),
    };
    const result = await createMcpChatResourceArchiveReader(source).getAlbum(key, 'album-a');
    expect(result.photos).toHaveLength(50);
    expect(result.photos.at(-1)).toMatchObject({ photoId: 'photo-49' });
  });

  it('records only bounded metadata for local MCP reads', async () => {
    const diagnostics: unknown[] = [];
    const reader = createMcpChatResourceArchiveReader({
      listArchived: async () => ({ items: [], nextCursor: null }), readArchived: async () => null,
    }, (value) => diagnostics.push(value));
    await reader.listNotes(key, 5);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source: 'mcp', accountId: key.accountId, chatId: key.chatId, action: 'note_list', status: 'success' });
    expect(JSON.stringify(diagnostics[0])).not.toContain('markdown');
  });
});
