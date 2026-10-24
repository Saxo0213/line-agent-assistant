import { createHash } from 'node:crypto';

function safeTitle(value: string | null | undefined, limit: number): string {
  const normalized = (value ?? '').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim();
  const withoutReservedPrefix = normalized.replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i, '_$1');
  let clipped = '';
  for (const character of withoutReservedPrefix || 'Untitled Album') {
    if (clipped.length + character.length > limit) break;
    clipped += character;
  }
  clipped = clipped.replace(/[. ]+$/g, '');
  return clipped || 'Untitled Album';
}

export function isReadableAlbumFolderName(value: string): boolean {
  return value.length <= 96 && /^[^\\/:*?"<>|\u0000-\u001f]{1,80}__[0-9a-f]{10}$/u.test(value) && !/[. ]$/.test(value);
}

export function isReadableAlbumPhotoName(value: string): boolean {
  return value.length <= 240 && /^LINE_ALBUM_[^\\/:*?"<>|\u0000-\u001f]{1,56}_[0-9]{8}_[0-9]{4,6}_[0-9a-f]{10}\.(jpg|png|webp|gif)$/u.test(value)
    && !/[. ]$/.test(value);
}

function shortHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 10); }

export function readableAlbumDirectoryName(title: string | null, albumId: string): string {
  return `${safeTitle(title, 80)}__${shortHash(albumId)}`;
}

export function readableAlbumPhotoName(input: { title: string | null; shotTime: number | null; sequence: number; photoId: string; extension: string }): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !/^(jpg|png|webp|gif)$/.test(input.extension)) throw new Error('Invalid readable album photo metadata.');
  const date = input.shotTime !== null && Number.isFinite(input.shotTime) && input.shotTime >= 0
    ? new Date(input.shotTime).toISOString().slice(0, 10).replace(/-/g, '') : '00000000';
  return `LINE_ALBUM_${safeTitle(input.title, 56)}_${date}_${String(input.sequence).padStart(4, '0')}_${shortHash(input.photoId)}.${input.extension}`;
}
