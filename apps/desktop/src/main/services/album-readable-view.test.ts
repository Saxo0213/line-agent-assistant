import { describe, expect, it } from 'vitest';
import { isReadableAlbumFolderName, isReadableAlbumPhotoName, readableAlbumDirectoryName, readableAlbumPhotoName } from './album-readable-view.js';

describe('readable album names', () => {
  it('sanitizes titles and keeps stable album/photo identity suffixes', () => {
    expect(readableAlbumDirectoryName('Summer / trip.', 'album-a')).toMatch(/^Summer trip__[0-9a-f]{10}$/);
    expect(readableAlbumPhotoName({ title: 'Summer / trip.', shotTime: 1_735_689_600_000, sequence: 3, photoId: 'photo-a', extension: 'jpg' }))
      .toMatch(/^LINE_ALBUM_Summer trip_20250101_0003_[0-9a-f]{10}\.jpg$/);
  });

  it('preserves legal punctuation and Unicode in LINE album titles', () => {
    const folderName = readableAlbumDirectoryName('旅遊 😀 # @', 'album-a');
    const photoName = readableAlbumPhotoName({ title: '旅遊 😀 # @', shotTime: null, sequence: 1, photoId: 'photo-a', extension: 'png' });
    expect(folderName).toMatch(/^旅遊 😀 # @__[0-9a-f]{10}$/u);
    expect(photoName).toMatch(/^LINE_ALBUM_旅遊 😀 # @_00000000_0001_[0-9a-f]{10}\.png$/u);
    expect(isReadableAlbumFolderName(folderName)).toBe(true);
    expect(isReadableAlbumPhotoName(photoName)).toBe(true);
    expect(isReadableAlbumFolderName(readableAlbumDirectoryName('😀'.repeat(100), 'album-long'))).toBe(true);
    expect(isReadableAlbumPhotoName(readableAlbumPhotoName({ title: '😀'.repeat(100), shotTime: null, sequence: 1, photoId: 'photo-long', extension: 'jpg' }))).toBe(true);
  });
});
