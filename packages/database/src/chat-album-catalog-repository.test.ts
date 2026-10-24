import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ConversationKey } from '@line-agent/contracts';
import { createTestDatabase } from './test-database.js';
import { ChatAlbumCatalogRepository } from './chat-album-catalog-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('ChatAlbumCatalogRepository with PostgreSQL', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: ChatAlbumCatalogRepository;
  const key: ConversationKey = { accountId: 'album-catalog-test', chatType: 'group', chatId: 'group-1' };
  let binding: { workerInstanceId: string; controlEpoch: number; mode: string };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new ChatAlbumCatalogRepository(pool);
    await pool.query("INSERT INTO line_accounts(account_id,mode,worker_instance_id) VALUES($1,'MONITOR_ONLY',NULL)", [key.accountId]);
    const control = await pool.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton=true');
    binding = { workerInstanceId: 'album-catalog-worker', controlEpoch: Number(control.rows[0]!.control_epoch), mode: 'ACTIVE_CONTROL' };
    await pool.query("UPDATE line_accounts SET mode='ACTIVE_CONTROL',worker_instance_id=$2,worker_binding_epoch=$3 WHERE account_id=$1",
      [key.accountId, binding.workerInstanceId, binding.controlEpoch]);
  });
  afterAll(async () => { await close?.(); });

  it('stores complete identity pages and the exact native file record under the current binding', async () => {
    const albumId = 'album-unique';
    const photoId = 'photo-unique';
    const albumGeneration = await repository.beginAlbumScan(key, binding);
    await repository.appendAlbumPage(key, albumGeneration, null, [{ albumId, chatId: key.chatId, title: 'Trip', photoCount: 1,
      createTime: null, updateTime: null }], null, binding);
    const albums = await repository.listAlbums(key, null);
    expect(albums.items.map(({ albumId: id }) => id)).toEqual([albumId]);

    const photoGeneration = await repository.beginPhotoScan(key, albumId, binding);
    await repository.appendPhotoPage(key, albumId, photoGeneration, null, [{ photoId, oid: 'oid', prefix: 'album/a', shotTime: null, width: 40, height: 30 }], 'page-2', binding);
    await expect(repository.photoScan(key, albumId)).resolves.toMatchObject({ complete: false, generation: photoGeneration, cursor: 'page-2' });
    const file = { folderName: 'a'.repeat(64), fileName: 'record_f_native-record.jpg', contentHash: 'b'.repeat(64), byteCount: 123, revision: 7,
      savedAt: '2026-10-25T00:00:00.000Z' };
    await repository.savePhoto(key, albumId, photoId, file, binding);
    await expect(repository.firstPhotoIds(key, [albumId], 2)).resolves.toEqual(new Map([[albumId, [photoId]]]));
    await repository.appendPhotoPage(key, albumId, photoGeneration, 'page-2', [], null, binding);

    expect((await repository.listPhotos(key, albumId, null)).items).toEqual([{ photoId, oid: 'oid', prefix: 'album/a', shotTime: null, width: 40, height: 30 }]);
    const saved = await pool.query<{ archive_folder: string; archive_file_name: string; content_hash: string; byte_count: string; archive_revision: string }>(
      'SELECT archive_folder,archive_file_name,content_hash,byte_count,archive_revision FROM chat_album_photos WHERE account_id=$1 AND album_id=$2 AND photo_id=$3',
      [key.accountId, albumId, photoId]);
    expect(saved.rows[0]).toEqual({ archive_folder: file.folderName, archive_file_name: file.fileName, content_hash: file.contentHash,
      byte_count: '123', archive_revision: '7' });
    await expect(repository.savedPhoto(key, albumId, photoId)).resolves.toEqual(file);
  });

  it('rejects a catalog write after the account binding changes', async () => {
    await pool.query("UPDATE line_accounts SET worker_instance_id='replacement-worker' WHERE account_id=$1", [key.accountId]);
    await expect(repository.beginAlbumScan(key, binding)).rejects.toThrow('Album catalog binding changed');
    await pool.query('UPDATE line_accounts SET worker_instance_id=$2 WHERE account_id=$1', [key.accountId, binding.workerInstanceId]);
  });

  it('allows only exact replay after terminal single-item and empty pages', async () => {
    const albumGeneration = await repository.beginAlbumScan(key, binding);
    const oneAlbum = { albumId: 'album-terminal-single', chatId: key.chatId, title: 'one', photoCount: 1, createTime: null, updateTime: null };
    await repository.appendAlbumPage(key, albumGeneration, null, [oneAlbum], null, binding);
    await expect(repository.appendAlbumPage(key, albumGeneration, null, [oneAlbum], null, binding)).resolves.toMatchObject({ nextOrdinal: 1, complete: true });
    await expect(repository.appendAlbumPage(key, albumGeneration, null, [{ ...oneAlbum, albumId: 'album-injected' }], null, binding)).rejects.toThrow('scan is complete');
    await expect(repository.appendAlbumPage(key, albumGeneration, null, [oneAlbum], 'unexpected-next', binding)).rejects.toThrow('scan is complete');
    expect((await repository.albumScanState(key))).toMatchObject({ complete: true, generation: albumGeneration, cursor: null, nextOrdinal: 1 });
    expect((await repository.listAlbums(key, null)).items.map(({ albumId }) => albumId)).toEqual([oneAlbum.albumId]);

    const emptyAlbumGeneration = await repository.beginAlbumScan(key, binding);
    await repository.appendAlbumPage(key, emptyAlbumGeneration, null, [], null, binding);
    await expect(repository.appendAlbumPage(key, emptyAlbumGeneration, null, [], null, binding)).resolves.toMatchObject({ nextOrdinal: 0, complete: true });
    await expect(repository.appendAlbumPage(key, emptyAlbumGeneration, null, [oneAlbum], null, binding)).rejects.toThrow('scan is complete');
    expect(await repository.albumScanState(key)).toMatchObject({ complete: true, generation: emptyAlbumGeneration, cursor: null, nextOrdinal: 0 });
    expect((await repository.listAlbums(key, null)).items).toEqual([]);

    const photoAlbum = { ...oneAlbum, albumId: 'album-terminal-photos' };
    const listingGeneration = await repository.beginAlbumScan(key, binding);
    await repository.appendAlbumPage(key, listingGeneration, null, [photoAlbum], null, binding);
    const photoGeneration = await repository.beginPhotoScan(key, photoAlbum.albumId, binding);
    const onePhoto = { photoId: 'photo-terminal-single', oid: 'oid-one', prefix: 'album/a' as const, shotTime: null, width: null, height: null };
    await repository.appendPhotoPage(key, photoAlbum.albumId, photoGeneration, null, [onePhoto], null, binding);
    await expect(repository.appendPhotoPage(key, photoAlbum.albumId, photoGeneration, null, [onePhoto], null, binding)).resolves.toMatchObject({ nextOrdinal: 1, complete: true });
    await expect(repository.appendPhotoPage(key, photoAlbum.albumId, photoGeneration, null, [{ ...onePhoto, photoId: 'photo-injected' }], null, binding)).rejects.toThrow('scan is complete');
    await expect(repository.appendPhotoPage(key, photoAlbum.albumId, photoGeneration, null, [onePhoto], 'unexpected-next', binding)).rejects.toThrow('scan is complete');
    expect(await repository.photoScan(key, photoAlbum.albumId)).toMatchObject({ complete: true, generation: photoGeneration, cursor: null, nextOrdinal: 1 });
    expect((await repository.listPhotos(key, photoAlbum.albumId, null)).items.map(({ photoId }) => photoId)).toEqual([onePhoto.photoId]);

    const emptyPhotoGeneration = await repository.beginPhotoScan(key, photoAlbum.albumId, binding);
    await repository.appendPhotoPage(key, photoAlbum.albumId, emptyPhotoGeneration, null, [], null, binding);
    await expect(repository.appendPhotoPage(key, photoAlbum.albumId, emptyPhotoGeneration, null, [], null, binding)).resolves.toMatchObject({ nextOrdinal: 0, complete: true });
    await expect(repository.appendPhotoPage(key, photoAlbum.albumId, emptyPhotoGeneration, null, [onePhoto], null, binding)).rejects.toThrow('scan is complete');
    expect(await repository.photoScan(key, photoAlbum.albumId)).toMatchObject({ complete: true, generation: emptyPhotoGeneration, cursor: null, nextOrdinal: 0 });
    expect((await repository.listPhotos(key, photoAlbum.albumId, null)).items).toEqual([]);
  });

  it('keeps photo generations monotonic and hides a removed photo after a full rescan', async () => {
    const albumId = 'album-membership';
    let albumGeneration = await repository.beginAlbumScan(key, binding);
    await repository.appendAlbumPage(key, albumGeneration, null, [{ albumId, chatId: key.chatId, title: 'Trip', photoCount: 2,
      createTime: null, updateTime: 1_700_000_000_000 }], null, binding);
    let photoGeneration = await repository.beginPhotoScan(key, albumId, binding);
    await repository.appendPhotoPage(key, albumId, photoGeneration, null, [
      { photoId: 'photo-a', oid: 'oid-a', prefix: 'album/a', shotTime: null, width: null, height: null },
      { photoId: 'photo-b', oid: 'oid-b', prefix: 'album/a', shotTime: null, width: null, height: null },
    ], null, binding);
    expect((await repository.listPhotos(key, albumId, null)).items.map(({ photoId }) => photoId)).toEqual(['photo-a', 'photo-b']);

    albumGeneration = await repository.beginAlbumScan(key, binding);
    await repository.appendAlbumPage(key, albumGeneration, null, [{ albumId, chatId: key.chatId, title: 'Trip', photoCount: 1,
      createTime: null, updateTime: 1_700_000_000_001 }], null, binding);
    const invalidated = await repository.photoScan(key, albumId);
    expect(invalidated?.complete).toBe(false);
    expect(invalidated?.cursor).toBeNull();
    expect(invalidated!.generation).toBeGreaterThan(photoGeneration);
    photoGeneration = await repository.beginPhotoScan(key, albumId, binding);
    await repository.appendPhotoPage(key, albumId, photoGeneration, null, [
      { photoId: 'photo-a', oid: 'oid-a', prefix: 'album/a', shotTime: null, width: null, height: null },
    ], null, binding);
    expect((await repository.listPhotos(key, albumId, null)).items.map(({ photoId }) => photoId)).toEqual(['photo-a']);
  });

  it('pages 501 out-of-order photos and albums by append ordinal, with crash replay and scan fencing', async () => {
    const albumGeneration = await repository.beginAlbumScan(key, binding);
    const albums = Array.from({ length: 501 }, (_, index) => ({ albumId: `album-${String(500 - index).padStart(3, '0')}`,
      chatId: key.chatId, title: null, photoCount: 0, createTime: null, updateTime: null }));
    let lineCursor: string | null = null;
    for (let offset = 0; offset < albums.length; offset += 50) {
      const page = albums.slice(offset, offset + 50);
      const next = offset + page.length < albums.length ? `albums-${offset + page.length}` : null;
      await repository.appendAlbumPage(key, albumGeneration, lineCursor, page, next, binding);
      if (offset === 0) {
        await expect(repository.appendAlbumPage(key, albumGeneration, lineCursor, page, next, binding)).resolves.toMatchObject({ nextOrdinal: 50, complete: false });
      }
      lineCursor = next;
    }
    const allAlbums: string[] = [];
    let albumCursor: string | null = null;
    do { const page = await repository.listAlbums(key, albumCursor, 50); allAlbums.push(...page.items.map((row) => row.albumId)); albumCursor = page.nextCursor; } while (albumCursor);
    expect(allAlbums).toEqual(albums.map(({ albumId }) => albumId));

    const photosAlbum = 'album-out-of-order-photos';
    const photoListGeneration = await repository.beginAlbumScan(key, binding);
    await repository.appendAlbumPage(key, photoListGeneration, null, [{ albumId: photosAlbum, chatId: key.chatId, title: null,
      photoCount: 501, createTime: null, updateTime: null }], null, binding);
    const photoGeneration = await repository.beginPhotoScan(key, photosAlbum, binding);
    const photos = Array.from({ length: 501 }, (_, index) => ({ photoId: index === 500 ? 'a-tail' : `z-${String(index).padStart(3, '0')}`,
      oid: `oid-${index}`, prefix: 'album/a' as const, shotTime: null, width: null, height: null }));
    lineCursor = null;
    for (let offset = 0; offset < photos.length; offset += 50) {
      const page = photos.slice(offset, offset + 50);
      const next = offset + page.length < photos.length ? `photos-${offset + page.length}` : null;
      await repository.appendPhotoPage(key, photosAlbum, photoGeneration, lineCursor, page, next, binding);
      lineCursor = next;
    }
    const allPhotos: string[] = [];
    let photoCursor: string | null = null;
    do { const page = await repository.listPhotos(key, photosAlbum, photoCursor, 50); allPhotos.push(...page.items.map((row) => row.photoId)); photoCursor = page.nextCursor; } while (photoCursor);
    expect(allPhotos).toEqual(photos.map(({ photoId }) => photoId));

    const competingGeneration = await repository.beginPhotoScan(key, photosAlbum, binding);
    const firstPage = photos.slice(0, 1);
    const settled = await Promise.allSettled([
      repository.appendPhotoPage(key, photosAlbum, competingGeneration, null, firstPage, 'p1', binding),
      repository.appendPhotoPage(key, photosAlbum, competingGeneration, null, [{ ...firstPage[0]!, photoId: 'other-id' }], 'p1', binding),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });
});
