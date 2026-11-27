// Chat resources (Notes, Albums) through the linejs flows of the linejs CLI:
//   Notes:  cli/src/commands/timeline.ts "timeline list" (line 164) and "timeline get" (line 190)
//           -> LinejsFullClient.listNotes / LinejsFullClient.getNote
//   Albums: cli/src/commands/moa.ts "moa albums" (line 38), "moa photos" (line 108), "moa download" (line 149)
//           -> LinejsFullClient.listAlbums / listAlbumPhotos / downloadAlbumPhoto
// Each call passes only the arguments that the CLI passes. linejs sets the defaults.
import type { LinejsFullClient } from './linejs-client-full.js';
import { InternalError } from '@evex/linejs/base';
import type { ChatResourceReadCommand, ChatResourcePhotoPageShape, JsonValue } from '@line-agent/contracts';
import { boundedChatResourceResponseCode, ChatResourceFailure, safeChatResourceFailureDetails,
  safeChatResourceUpstreamCode, safeChatResourceUpstreamMessage, safeChatResourceUpstreamNumber } from './chat-resource-error.js';
import { safeRaw } from './normalizer.js';

export type ChatResourceValue = {
  nextCursor?: string | null; notes?: readonly unknown[]; note?: unknown; albums?: readonly unknown[];
  photos?: readonly unknown[]; photoPageShape?: ChatResourcePhotoPageShape; bytes?: Uint8Array;
};

function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function normalizeChatNote(value: unknown): { postId: string; createdTime: number | null; text: string | null; content?: Record<string, JsonValue> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LINE_NOTE_SHAPE_INVALID');
  const post = value as Record<string, unknown>;
  const postId = post.postId ?? post.id;
  const contents = post.contents && typeof post.contents === 'object' && !Array.isArray(post.contents)
    ? post.contents as Record<string, unknown> : {};
  if (typeof postId !== 'string' && typeof postId !== 'number') throw new Error('LINE_NOTE_ID_INVALID');
  const content = safeRaw(contents);
  return { postId: String(postId), createdTime: finiteNonnegative(post.createdTime ?? post.updateTime),
    text: typeof contents.text === 'string' ? contents.text : typeof post.text === 'string' ? post.text : null,
    ...(content && typeof content === 'object' && !Array.isArray(content) ? { content: content as Record<string, JsonValue> } : {}) };
}

export async function readLinejsChatResource(full: LinejsFullClient, command: ChatResourceReadCommand, signal: AbortSignal): Promise<ChatResourceValue> {
  if (!full.authToken || !full.profile?.mid) throw new Error('chat resources require a logged-in account');
  if (signal.aborted) throw signal.reason;
  const stage = async <T>(category: 'list_get_transport_failure' | 'normalization_failure', operation: () => Promise<T> | T): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (signal.aborted) throw error;
      const fields = safeChatResourceFailureDetails(error);
      throw new ChatResourceFailure(category, undefined, fields.failureKind, fields.upstreamStatus, fields.upstreamCode);
    }
  };
  const moa = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof InternalError && error.type === 'MoaError') {
        const data = error.data as Record<string, unknown> | undefined;
        if (data && Object.hasOwn(data, 'code')) throw new ChatResourceFailure('response_code_invalid', undefined,
          'linejs_internal', safeChatResourceUpstreamNumber(data.status), safeChatResourceUpstreamCode(data.code));
        if (data && Object.hasOwn(data, 'status')) throw new ChatResourceFailure('list_get_transport_failure', undefined,
          'linejs_internal', safeChatResourceUpstreamNumber(data.status));
        if (data) throw new ChatResourceFailure('response_shape_invalid', undefined, 'linejs_internal');
        if (error.message === 'Moa returned invalid JSON' || error.message === 'Moa returned an invalid response object') {
          throw new ChatResourceFailure('response_shape_invalid', undefined, 'linejs_internal');
        }
      }
      const fields = safeChatResourceFailureDetails(error);
      throw new ChatResourceFailure('list_get_transport_failure', undefined, fields.failureKind, fields.upstreamStatus, fields.upstreamCode);
    }
  };
  // A direct chat keeps its notes and albums under the LINE one-to-one chat id ("o" + 32 hex), not the peer MID. A group or room uses its own chat id.
  const homeId = command.chatType === 'direct' && command.homeChatId ? command.homeChatId : command.chatId;
  if (command.action === 'listNotes' || command.action === 'getNote') {
    const response = await stage('list_get_transport_failure', () => command.action === 'listNotes'
      ? full.listNotes({ homeId, ...(command.cursor ? { postId: command.cursor } : {}) })
      : full.getNote({ homeId, postId: command.postId! }));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatResourceFailure('response_shape_invalid');
    const raw = response as unknown as Record<string, unknown>;
    if (raw.code !== 0) throw new ChatResourceFailure('response_code_invalid', boundedChatResourceResponseCode(raw.code, Object.hasOwn(raw, 'code')),
      undefined, undefined, undefined, safeChatResourceUpstreamMessage(raw.message));
    if (!raw.result || typeof raw.result !== 'object' || Array.isArray(raw.result)) throw new ChatResourceFailure('response_shape_invalid');
    const data = raw.result as Record<string, unknown>;
    const posts = Array.isArray(data.posts) ? data.posts : command.action === 'getNote' ? [data.post ?? data] : [];
    const notes = await stage('normalization_failure', () => posts.slice(0, command.limit ?? 50).map((post) => normalizeChatNote(post)));
    const next = data.nextCursor ?? data.nextPostId ?? data.cursor;
    return command.action === 'getNote' ? { note: notes[0] } : {
      notes, nextCursor: typeof next === 'string' && next.length <= 2048 ? next : null,
    };
  }
  if (command.action === 'listAlbums') {
    const response = await moa(() => full.listAlbums({ ...(command.cursor === undefined || command.cursor === null ? {} : { cursor: command.cursor }) }));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatResourceFailure('response_shape_invalid');
    const albumResult = response.result;
    const albums = albumResult?.albums;
    if (!albumResult || !Array.isArray(albums)) throw new ChatResourceFailure('response_shape_invalid');
    return await stage('normalization_failure', () => ({ albums: albums.filter((album) => album.chatId === homeId).slice(0, command.limit ?? 50).map((album) => ({
      albumId: String(album.albumId), chatId: command.chatId, title: typeof album.title === 'string' ? album.title : null,
      photoCount: finiteNonnegative(album.photoCount), createTime: finiteNonnegative(album.createTime), updateTime: finiteNonnegative(album.updateTime),
    })), nextCursor: typeof albumResult.nextCursor === 'string' ? albumResult.nextCursor : albumResult.hasMore ? albumResult.cursor ?? null : null }));
  }
  if (command.action === 'listAlbumPhotos') {
    const response = await moa(() => full.listAlbumPhotos({ chatId: homeId, albumId: command.albumId!,
      ...(command.cursor === undefined || command.cursor === null ? {} : { cursor: command.cursor }), pageSize: command.limit ?? 50 }));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatResourceFailure('response_shape_invalid');
    const photoResult = response.result;
    const photos = photoResult?.photos;
    if (!photoResult || !Array.isArray(photos)) throw new ChatResourceFailure('response_shape_invalid');
    const page = photoResult as typeof photoResult & { hasMore?: boolean; cursor?: string };
    const hasMorePresent = Object.hasOwn(photoResult, 'hasMore');
    const hasMore = typeof page.hasMore === 'boolean' ? page.hasMore : undefined;
    const rawNextCursor = typeof photoResult.nextCursor === 'string' ? photoResult.nextCursor : null;
    const photoPageShape = { rawPhotoCount: photos.length, hasMorePresent, ...(hasMore === undefined ? {} : { hasMore }),
      nextCursorRelation: rawNextCursor === null ? 'absent' as const
        : rawNextCursor === (command.cursor ?? null) ? 'same' as const : 'advanced' as const };
    const nextCursor = page.hasMore === false ? null : typeof photoResult.nextCursor === 'string' ? photoResult.nextCursor
      : page.hasMore === true && typeof page.cursor === 'string' ? page.cursor : null;
    return await stage('normalization_failure', () => ({ photos: photos.slice(0, command.limit ?? 50).flatMap((photo) => {
      const oid = photo.oid ?? photo.obsResourceId?.oid;
      const photoId = photo.photoId ?? photo.id ?? oid;
      if (oid === undefined || photoId === undefined) return [];
      return [{ photoId: String(photoId), oid: String(oid), prefix: photo.obsResourceId?.sid === 'v' || photo.resourceType === 'VIDEO' ? 'album/v' as const : 'album/a' as const,
        shotTime: finiteNonnegative(photo.shotTime), width: finitePositive(photo.width), height: finitePositive(photo.height) }];
    }), nextCursor, photoPageShape }));
  }
  const bytes = await moa(() => full.downloadAlbumPhoto({ chatId: homeId, albumId: command.albumId!,
    oid: command.oid!, prefix: command.prefix! }));
  if (bytes.byteLength > command.maxBytes!) throw new ChatResourceFailure('response_validation');
  if (signal.aborted) throw signal.reason;
  return { bytes };
}
