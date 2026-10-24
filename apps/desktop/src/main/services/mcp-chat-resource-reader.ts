import type { ConversationKey } from '@line-agent/contracts';
import { chatResourcePhotoId, chatResourcePhotoPageId } from './chat-resources.js';

const MAX_ALBUM_PHOTO_PAGES = 20;
const MAX_ALBUM_PHOTOS = 50;

/** Injected bounded archive reader; implementations must read only generated files under the canonical chat folder. */
export interface McpChatResourceReader {
  listNotes(key: ConversationKey, limit: number, cursor?: string, signal?: AbortSignal): Promise<{ notes: unknown[]; nextCursor: string | null; savedAt: string | null }>;
  getNote(key: ConversationKey, noteId: string, signal?: AbortSignal): Promise<{ note: unknown | null; savedAt: string | null }>;
  listAlbums(key: ConversationKey, limit: number, cursor?: string, signal?: AbortSignal): Promise<{ albums: unknown[]; nextCursor: string | null; savedAt: string | null }>;
  getAlbum(key: ConversationKey, albumId: string, signal?: AbortSignal): Promise<{ album: unknown | null; photos: unknown[]; savedAt: string | null }>;
}

export interface ArchivedChatResourceSource {
  listArchived(key: ConversationKey, kind: 'note' | 'album' | 'photo-page' | 'photo', cursor: string | null, signal?: AbortSignal, limit?: number): Promise<{
    items: Array<{ resourceId: string; revision: number; savedAt: string; contentHash: string; byteLength: number }>;
    nextCursor: string | null;
  }>;
  readArchived(key: ConversationKey, kind: 'note' | 'album' | 'photo-page' | 'photo', resourceId: string, signal?: AbortSignal): Promise<{
    revision: number; savedAt: string; content: Uint8Array; contentHash: string; byteLength: number;
  } | null>;
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Local only MCP projection. Every query reads the archive and never asks the LINE worker to sync. */
export function createMcpChatResourceArchiveReader(source: ArchivedChatResourceSource, recordDiagnostic?: (record: unknown) => void): McpChatResourceReader {
  const emitDiagnostic = (record: unknown): void => { try { recordDiagnostic?.(record); } catch { /* diagnostics never change a read result */ } };
  async function instrument<T>(key: ConversationKey, action: 'note_list' | 'note_detail' | 'album_list' | 'album_photos', run: () => Promise<T>): Promise<T> {
    const started = Date.now(); const occurredAt = new Date(started).toISOString();
    try {
      const value = await run();
      let byteCount = 0; try { byteCount = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { /* omit unmeasurable size */ }
      const itemCount = value && typeof value === 'object' && 'notes' in value ? (value as { notes: unknown[] }).notes.length
        : value && typeof value === 'object' && 'albums' in value ? (value as { albums: unknown[] }).albums.length
          : value && typeof value === 'object' && 'photos' in value ? (value as { photos: unknown[] }).photos.length
            : value && typeof value === 'object' && 'note' in value ? Number((value as { note: unknown }).note !== null) : 0;
      const responseFields = value && typeof value === 'object' ? Object.entries(value).slice(0, 32).map(([name, field]) => ({ name,
        type: field === null ? 'null' : Array.isArray(field) ? 'array' : typeof field === 'object' ? 'object' : typeof field })) : [];
      emitDiagnostic({ source: 'mcp', accountId: key.accountId, chatId: key.chatId, action, occurredAt,
        durationMs: Date.now() - started, status: 'success', itemCount, byteCount, responseFields });
      return value;
    } catch {
      emitDiagnostic({ source: 'mcp', accountId: key.accountId, chatId: key.chatId, action, occurredAt,
        durationMs: Date.now() - started, status: 'failure', errorCode: 'UNKNOWN', itemCount: 0, byteCount: 0, responseFields: [] });
      throw new Error('Saved chat resources are unavailable.');
    }
  }
  return {
    async listNotes(key, limit, cursor, signal) { return instrument(key, 'note_list', async () => {
      const page = await source.listArchived(key, 'note', cursor ?? null, signal, limit);
      const rows = page.items.slice(0, limit);
      return { notes: rows.map((item) => ({ noteId: item.resourceId, savedAt: item.savedAt })),
        nextCursor: page.nextCursor, savedAt: rows.map((item) => item.savedAt).sort().at(-1) ?? null };
    }); },
    async getNote(key, noteId, signal) { return instrument(key, 'note_detail', async () => {
      const item = await source.readArchived(key, 'note', noteId, signal);
      return { note: item ? { noteId, markdown: Buffer.from(item.content).toString('utf8'), savedAt: item.savedAt } : null,
        savedAt: item?.savedAt ?? null };
    }); },
    async listAlbums(key, limit, cursor, signal) { return instrument(key, 'album_list', async () => {
      const page = await source.listArchived(key, 'album', cursor ?? null, signal, limit);
      const albums: unknown[] = [];
      let savedAt: string | null = null;
      for (const item of page.items.slice(0, limit)) {
        const record = await source.readArchived(key, 'album', item.resourceId, signal);
        const value = record && decodeJson(record.content);
        if (!record || value?._linejsGenerated !== 'album-v1' || value.chatId !== key.chatId || value.albumId !== item.resourceId) continue;
        const { _linejsGenerated: _marker, ...album } = value;
        albums.push({ ...album, savedAt: record.savedAt });
        if (!savedAt || record.savedAt > savedAt) savedAt = record.savedAt;
      }
      return { albums, nextCursor: page.nextCursor, savedAt };
    }); },
    async getAlbum(key, albumId, signal) { return instrument(key, 'album_photos', async () => {
      const albumRecord = await source.readArchived(key, 'album', albumId, signal);
      const albumValue = albumRecord && decodeJson(albumRecord.content);
      const album = albumValue?._linejsGenerated === 'album-v1' && albumValue.chatId === key.chatId && albumValue.albumId === albumId
        ? (() => { const { _linejsGenerated: _marker, ...value } = albumValue; return value; })() : null;
      if (!album) return { album: null, photos: [], savedAt: albumRecord?.savedAt ?? null };
      const photos: unknown[] = [];
      const seenCursors = new Set<string | null>();
      const seenPhotos = new Set<string>();
      let cursor: string | null = null;
      for (let pageCount = 0; pageCount < MAX_ALBUM_PHOTO_PAGES && photos.length < MAX_ALBUM_PHOTOS; pageCount++) {
        if (seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
        const record = await source.readArchived(key, 'photo-page', chatResourcePhotoPageId(albumId, cursor), signal);
        const value = record && decodeJson(record.content);
        if (value?._linejsGenerated !== 'album-photos-v1' || value.albumId !== albumId || value.cursor !== cursor
          || !Array.isArray(value.photos) || value.photos.length > MAX_ALBUM_PHOTOS
          || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2048))) break;
        for (const photo of value.photos) {
          if (photos.length >= MAX_ALBUM_PHOTOS) break;
          if (!photo || typeof photo !== 'object' || Array.isArray(photo)) continue;
          const row = photo as Record<string, unknown>;
          if (typeof row.photoId !== 'string' || seenPhotos.has(row.photoId)) continue;
          seenPhotos.add(row.photoId);
          const savedPhoto = await source.readArchived(key, 'photo', chatResourcePhotoId(albumId, row.photoId), signal);
          photos.push({ photoId: row.photoId, shotTime: row.shotTime ?? null, width: row.width ?? null,
            height: row.height ?? null, available: savedPhoto !== null });
        }
        if (value.nextCursor === null) break;
        cursor = value.nextCursor;
      }
      return { album, photos, savedAt: albumRecord?.savedAt ?? null };
    }); },
  };
}
