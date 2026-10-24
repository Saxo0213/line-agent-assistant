import { createHash, randomUUID } from 'node:crypto';
import type { AlbumFailureContextDto, ConversationKey, InboundEnvelope } from '@line-agent/contracts';
import type { OperationalAudit } from './operational-audit.js';
import type { ChatAlbumCatalogAlbum, ChatAlbumCatalogPhoto, ChatAlbumCatalogBinding, ChatAlbumSavedFile } from '@line-agent/database';

export const CHAT_RESOURCE_PAGE_LIMIT = 50;
export const CHAT_RESOURCE_PHOTO_LIMIT = 50;
export const CHAT_RESOURCE_IMAGE_LIMIT = 20 * 1024 * 1024;
export const CHAT_RESOURCE_ALBUM_OPEN_ITEM_LIMIT = 500;
export const CHAT_RESOURCE_ALBUM_OPEN_BYTE_LIMIT = 256 * 1024 * 1024;
const MAX_NOTE_TEXT = 256 * 1024;
const MAX_METADATA_TEXT = 20_000;
const MAX_ARCHIVE_PENDING = 32;
const MAX_ARCHIVE_ACTIVE = 4;
const MAX_ALBUM_OPEN_PAGES = 10;
function decodeCatalogCursor(value: string | null, prefix: 'db-album:' | 'db-photo:'): { generation: number; ordinal: number } | null {
  if (!value?.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8')) as { generation?: unknown; ordinal?: unknown };
    if (Number.isSafeInteger(parsed.generation) && Number(parsed.generation) > 0 && Number.isSafeInteger(parsed.ordinal) && Number(parsed.ordinal) >= -1) {
      return { generation: Number(parsed.generation), ordinal: Number(parsed.ordinal) };
    }
  } catch { /* malformed cursor is rejected below */ }
  throw new Error('Invalid album catalog cursor.');
}
function encodeCatalogCursor(prefix: 'db-album:' | 'db-photo:', generation: number, ordinal: number): string {
  return `${prefix}${Buffer.from(JSON.stringify({ generation, ordinal }), 'utf8').toString('base64url')}`;
}
const GENERATED_NOTE_MARKER = '<!-- linejs-generated-note:v1 -->';

export type ChatResourceAction = 'listNotes' | 'getNote' | 'listAlbums' | 'listAlbumPhotos' | 'downloadAlbumPhoto';
export type ChatResourceKind = 'note' | 'album' | 'photo-page' | 'photo';
export type AlbumFailureAction = 'album_list' | 'album_photos' | 'photo_download';
export type AlbumFailureStage = 'resource_read' | 'pagination' | 'archive_contains' | 'archive_write' | 'archive_scan';
export type AlbumTaskFailureStage = 'archive_scan' | 'album_list' | 'album_list_pagination' | 'album_photos'
  | 'photo_download' | 'photo_pagination' | 'archive_contains' | 'archive_write' | 'source_validation' | 'unknown';
export type AlbumTaskFailureCode = 'ALBUM_RECONCILIATION_FAILED' | 'ALBUM_ARCHIVE_INCOMPLETE' | 'ALBUM_PHOTO_CURSOR_LOOP';
export type AlbumFailureContext = AlbumFailureContextDto;
export class AlbumArchiveFailure extends Error {
  constructor(readonly failureContext: AlbumFailureContext) { super(failureContext.code); this.name = 'AlbumArchiveFailure'; }
}
export function albumTaskFailureStage(context: AlbumFailureContext): AlbumTaskFailureStage {
  if (context.stage === 'pagination') return context.action === 'album_list' ? 'album_list_pagination' : 'photo_pagination';
  if (context.stage === 'archive_contains' || context.stage === 'archive_write' || context.stage === 'archive_scan') return context.stage;
  return context.action;
}
export function albumFailureContextFrom(error: unknown): AlbumFailureContext | undefined {
  if (error instanceof AlbumArchiveFailure) return error.failureContext;
  return undefined;
}
export type ChatResourceRequest = ConversationKey & { requestId: string; type: 'chatResourceRead'; action: ChatResourceAction;
  workerInstanceId: string; controlEpoch: number; transportOwnerId: string; transportGeneration: number; writeGrantVersion: number;
  timeoutMs: number; limit?: number; maxBytes?: number; cursor?: string;
  postId?: string; albumId?: string; photoId?: string; oid?: string; prefix?: string };
export type ChatResourceReadResult = { type: 'chatResourceResult'; requestId: string; action: ChatResourceAction; ok: boolean; error?: string | null | undefined;
  responseCode?: number | 'missing' | 'non_numeric' | undefined;
  failureKind?: 'linejs_internal' | 'effect_denied' | 'type_error' | 'range_error' | 'timeout_error' | 'abort_error' | 'other' | undefined;
  upstreamStatus?: number | undefined; upstreamCode?: number | 'missing' | 'non_numeric' | undefined;
  accountId: string; workerInstanceId: string; controlEpoch: number; chatType: ConversationKey['chatType']; chatId: string;
  notes?: NoteDto[] | undefined; note?: NoteDto | undefined; albums?: AlbumDto[] | undefined; photos?: PhotoDto[] | undefined;
  photoPageShape?: { rawPhotoCount: number; hasMorePresent: boolean; hasMore?: boolean | undefined; nextCursorRelation: 'absent' | 'same' | 'advanced' } | undefined;
  nextCursor?: string | null | undefined; bytes?: Uint8Array | undefined };
export type ChatResourceBinding = { accountId: string; workerInstanceId: string; controlEpoch: number; transportOwnerId: string;
  transportGeneration: number; writeGrantVersion: number; mode: string };
export type ChatResourceArchiveVersion = { revision: number; savedAt: string; content: Uint8Array; contentHash: string; byteLength: number };
export type ChatResourceAlbumPhotoFile = ChatAlbumSavedFile;
export type ChatResourceArchiveItem = { resourceId: string; revision: number; savedAt: string; contentHash: string; byteLength: number };
export type ChatResourceArchivePage = { items: ChatResourceArchiveItem[]; nextCursor: string | null };
export type AlbumOpenResult = { albumId: string; savedCount: number; failedCount: number; totalCount: number; byteCount: number;
  complete: boolean; failureCodes: string[]; errorCode: string | null; nextCursor: string | null; nextPhotoIndex: number;
  failureContext?: AlbumFailureContext };

/** Main-facing boundary implemented by the one bounded native archive owner. Paths never cross this seam.
 * `publish` stages first, invokes guard immediately before final commit, and serializes commit/cancel messages. */
export interface ChatResourceStore {
  publish(input: { key: ConversationKey; kind: ChatResourceKind; resourceId: string; content: Uint8Array; signal: AbortSignal;
    guard: () => void }): Promise<Omit<ChatResourceArchiveVersion, 'content'>>;
  read(input: { key: ConversationKey; kind: ChatResourceKind; resourceId: string; signal?: AbortSignal }): Promise<ChatResourceArchiveVersion | null>;
  list(input: { key: ConversationKey; kind: ChatResourceKind; limit: number; cursor?: string | null; signal?: AbortSignal }): Promise<ChatResourceArchivePage>;
  ensureAlbumFolder?(input: { key: ConversationKey; albumId: string; signal: AbortSignal; guard: () => void }): Promise<void>;
  inspectAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; signal: AbortSignal; guard: () => void }): Promise<ChatResourceAlbumPhotoFile | null>;
  readAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; signal: AbortSignal; guard: () => void }): Promise<(ChatResourceAlbumPhotoFile & { content: Uint8Array }) | null>;
  hasAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; signal: AbortSignal; guard: () => void }): Promise<boolean>;
  publishAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; content: Uint8Array; signal: AbortSignal;
    guard: () => void }): Promise<ChatResourceAlbumPhotoFile | void>;
  close(): Promise<void>;
  /** Synchronously terminates the bounded native owner after close/drain grace expires. */
  forceClose(): void;
}

export type ChatResourceArchiveDependencies = {
  readChatResource(command: ChatResourceRequest, signal?: AbortSignal): Promise<ChatResourceReadResult>;
  store?: ChatResourceStore;
  catalog?: {
    albumScanState(key: ConversationKey): Promise<{ complete: boolean; generation: number; cursor: string | null; previousCursor: string | null; nextOrdinal: number }>;
    beginAlbumScan(key: ConversationKey, binding: ChatAlbumCatalogBinding): Promise<number>;
    appendAlbumPage(key: ConversationKey, generation: number, expectedCursor: string | null, albums: readonly ChatAlbumCatalogAlbum[], nextCursor: string | null, binding: ChatAlbumCatalogBinding): Promise<{ nextOrdinal: number; complete: boolean }>;
    listAlbums(key: ConversationKey, cursor: string | null, limit?: number): Promise<{ items: ChatAlbumCatalogAlbum[]; nextCursor: string | null }>;
    firstPhotoIds?(key: ConversationKey, albumIds: readonly string[], limit?: number): Promise<Map<string, string[]>>;
    beginPhotoScan(key: ConversationKey, albumId: string, binding: ChatAlbumCatalogBinding): Promise<number>;
    appendPhotoPage(key: ConversationKey, albumId: string, generation: number, expectedCursor: string | null, photos: readonly ChatAlbumCatalogPhoto[], nextCursor: string | null, binding: ChatAlbumCatalogBinding): Promise<{ nextOrdinal: number; complete: boolean }>;
    photoScan(key: ConversationKey, albumId: string): Promise<{ complete: boolean; generation: number; cursor: string | null; previousCursor: string | null; nextOrdinal: number } | null>;
    listPhotos(key: ConversationKey, albumId: string, cursor: string | null, limit?: number): Promise<{ items: ChatAlbumCatalogPhoto[]; nextCursor: string | null }>;
    savedPhoto(key: ConversationKey, albumId: string, photoId: string): Promise<ChatAlbumSavedFile | null>;
    savePhoto(key: ConversationKey, albumId: string, photoId: string, file: ChatAlbumSavedFile, binding: ChatAlbumCatalogBinding): Promise<void>;
    clearSavedPhoto(key: ConversationKey, albumId: string, photoId: string, binding: ChatAlbumCatalogBinding): Promise<void>;
  };
  isWritableAccount(accountId: string): Promise<boolean>;
  getBinding(accountId: string): Promise<ChatResourceBinding | null>;
  isCurrentBinding(binding: ChatResourceBinding): boolean;
  conversationExists(key: ConversationKey): Promise<boolean>;
  recordDiagnostic?(record: unknown): void;
  audit?: Pick<OperationalAudit, 'outcome'>;
  /** Lower test budgets are useful for exercising the same hard capped admission logic. */
  albumOpenByteLimit?: number;
};
type AdmissionTask = { key: ConversationKey; generation: number; controller: AbortController; signal: AbortSignal | undefined;
  run: (signal: AbortSignal, generation: number) => Promise<unknown>; resolve(value: unknown): void; reject(reason: unknown): void;
  abortListener: (() => void) | undefined; settleReject(reason: unknown): void };

const ARCHIVE_SHUTDOWN_GRACE_MS = 500;
const ARCHIVE_FORCE_CLOSE_GRACE_MS = 100;

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true, () => false), new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export type NoteDto = { postId: string; createdTime: number | null; text: string | null; content?: Record<string, unknown> | undefined };
export type AlbumDto = { albumId: string; chatId: string; title: string | null; photoCount: number | null; createTime: number | null; updateTime: number | null; coverPhotoIds?: string[] };
export type PhotoDto = { photoId: string; oid: string; prefix: 'album/a' | 'album/v'; shotTime: number | null; width: number | null; height: number | null };
export function chatResourceConversationKey(value: { accountId: string; chatType: ConversationKey['chatType']; chatId: string }): ConversationKey {
  return { accountId: value.accountId, chatType: value.chatType, chatId: value.chatId };
}
/** Stable opaque IDs for resources whose identity is a tuple rather than one LINE ID. */
export function chatResourcePhotoPageId(albumId: string, cursor: string | null): string {
  return createHash('sha256').update(JSON.stringify([boundedId(albumId, 'album ID'), cursor])).digest('hex');
}
export function chatResourcePhotoId(albumId: string, photoId: string): string {
  return createHash('sha256').update(JSON.stringify([boundedId(albumId, 'album ID'), boundedId(photoId, 'photo ID')])).digest('hex');
}
export type ChatResourceIpcRequest = ConversationKey & { requestId: string; type: 'listChatNotes' | 'getChatNote' | 'listChatAlbums' | 'listChatAlbumPhotos' | 'downloadChatAlbumPhoto' | 'openChatAlbum';
  cursor?: string | null; postId?: string; albumId?: string; photoId?: string; oid?: string; prefix?: string; refresh?: boolean };

/** Fails closed until the handle-anchored native archive adapter is supplied by the desktop host. */
export const unavailableChatResourceStore: ChatResourceStore = {
  async publish() { throw new Error('CHAT_RESOURCE_STORE_UNAVAILABLE'); },
  async read() { throw new Error('CHAT_RESOURCE_STORE_UNAVAILABLE'); },
  async list() { throw new Error('CHAT_RESOURCE_STORE_UNAVAILABLE'); },
  async close() {},
  forceClose() {},
};

/** Classifies only native live POSTNOTIFICATION subtypes; generic, historical, and unknown events are not refresh signals. */
export function nativePostNotificationSubtype(envelope: InboundEnvelope): 'note' | 'album' | null {
  if (envelope.kind !== 'event' || envelope.ingestion.source !== 'live' || typeof envelope.raw !== 'object' || envelope.raw === null || Array.isArray(envelope.raw)) return null;
  const raw = envelope.raw as Record<string, unknown>;
  const message = raw.message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const nativeMessage = message as Record<string, unknown>;
  const contentType = nativeMessage.contentType;
  if (contentType !== 16 && contentType !== '16' && contentType !== 'POSTNOTIFICATION') return null;
  const metadata = nativeMessage.contentMetadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const serviceType = (metadata as Record<string, unknown>).serviceType;
  return serviceType === 'GB' ? 'note' : serviceType === 'AB' ? 'album' : null;
}

export function isNativeNotePostNotification(envelope: InboundEnvelope): boolean {
  return nativePostNotificationSubtype(envelope) === 'note';
}

function boundedId(value: string, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function sameChatResourceBinding(left: ChatResourceBinding, right: ChatResourceBinding): boolean {
  return left.accountId === right.accountId && left.workerInstanceId === right.workerInstanceId && left.controlEpoch === right.controlEpoch
    && left.transportOwnerId === right.transportOwnerId && left.transportGeneration === right.transportGeneration
    && left.writeGrantVersion === right.writeGrantVersion && left.mode === right.mode;
}
function wasChatResourceDiagnosticLogged(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { chatResourceDiagnosticLogged?: unknown }).chatResourceDiagnosticLogged === true;
}
function markChatResourceDiagnosticLogged(error: unknown): void {
  if (error && typeof error === 'object') (error as { chatResourceDiagnosticLogged?: boolean }).chatResourceDiagnosticLogged = true;
}
function safeId(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
function boundedText(value: unknown, limit: number, name: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit) throw new Error(`Invalid or oversized ${name}.`);
  return value;
}
function fenced(text: string, language: string): string {
  const runs = text.match(/`+/g) ?? [];
  const delimiter = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${delimiter}${language}\n${text}\n${delimiter}`;
}
function arrayResult<T>(value: unknown, key: string, limit: number): { rows: T[]; nextCursor: string | null } {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid chat resource response.');
  const record = value as Record<string, unknown>;
  const rows = record[key];
  const cursor = record.nextCursor ?? null;
  if (!Array.isArray(rows) || rows.length > limit || (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048))) throw new Error('Invalid chat resource page.');
  return { rows: rows as T[], nextCursor: cursor as string | null };
}
function noteDto(value: unknown): NoteDto {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid note response.');
  const row = value as Record<string, unknown>;
  const createdTime = row.createdTime === null ? null : boundedTimestamp(row.createdTime);
  const text = row.text === null ? null : boundedText(row.text, MAX_NOTE_TEXT, 'note text');
  const content = row.content === undefined ? undefined : row.content;
  if (content !== undefined && (typeof content !== 'object' || content === null || Array.isArray(content) || Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_NOTE_TEXT)) throw new Error('Invalid or oversized note content.');
  return { postId: boundedId(row.postId as string, 'post ID'), createdTime, text, ...(content === undefined ? {} : { content: content as Record<string, unknown> }) };
}
function boundedTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid chat resource timestamp.');
  return value;
}
function albumDto(value: unknown, expectedChatId: string): AlbumDto {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid album response.');
  const row = value as Record<string, unknown>;
  const nullableNumber = (v: unknown) => v === null ? null : boundedTimestamp(v);
  const title = row.title === null ? null : boundedText(row.title, MAX_METADATA_TEXT, 'album title');
  const count = row.photoCount === null ? null : row.photoCount;
  const album: AlbumDto = { albumId: boundedId(row.albumId as string, 'album ID'), chatId: boundedId(row.chatId as string, 'album chat ID'),
    title, photoCount: count as number | null, createTime: nullableNumber(row.createTime), updateTime: nullableNumber(row.updateTime) };
  if (album.chatId !== expectedChatId || (album.photoCount !== null && (!Number.isInteger(album.photoCount) || album.photoCount < 0 || album.photoCount > 100_000))) throw new Error('Album does not belong to the requested conversation.');
  return album;
}
function photoDto(value: unknown): PhotoDto {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid album photo response.');
  const row = value as Record<string, unknown>;
  const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : NaN;
  const nullableInt = (v: unknown) => v === null ? null : number(v);
  const shotTime = row.shotTime === null ? null : boundedTimestamp(row.shotTime);
  const width = nullableInt(row.width), height = nullableInt(row.height);
  if ((width !== null && !Number.isFinite(width)) || (height !== null && !Number.isFinite(height))) throw new Error('Invalid photo dimensions.');
  if (row.prefix !== 'album/a' && row.prefix !== 'album/v') throw new Error('Invalid album photo prefix.');
  return { photoId: boundedId(row.photoId as string, 'photo ID'), oid: boundedId(row.oid as string, 'photo object ID'),
    prefix: row.prefix, shotTime, width, height };
}
function contentBytes(value: unknown, maxBytes: number): Uint8Array {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.byteLength > maxBytes) throw new Error('Chat resource archive record exceeds its size limit.');
  return bytes;
}
function sameAlbumSavedFile(left: ChatAlbumSavedFile | null, right: ChatAlbumSavedFile | null): boolean {
  return !!left && !!right && left.folderName === right.folderName && left.fileName === right.fileName && left.contentHash === right.contentHash
    && left.byteCount === right.byteCount && left.revision === right.revision && left.savedAt === right.savedAt;
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function archiveFailureCode(error: unknown): string {
  if (error instanceof AlbumArchiveFailure) return error.failureContext.code;
  const value = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(value)) return value;
  const message = error instanceof Error ? error.message : '';
  if (['LINE_READ_FAILED', 'INVALID_IMAGE', 'ACCOUNT_BINDING_CHANGED', 'CHAT_RESOURCE_STORE_UNAVAILABLE'].includes(message)) return message;
  if (message === 'Invalid chat resource page.' || message === 'Invalid album photo response.') return 'INVALID_PAGE';
  return 'DOWNLOAD_FAILED';
}
function validateArchiveVersion(value: ChatResourceArchiveVersion): ChatResourceArchiveVersion {
  if (!value || !validRevision(value.revision) || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))
    || !(value.content instanceof Uint8Array) || !Number.isSafeInteger(value.byteLength) || value.byteLength !== value.content.byteLength
    || value.byteLength > CHAT_RESOURCE_IMAGE_LIMIT + MAX_NOTE_TEXT * 2 || !/^[0-9a-f]{64}$/.test(value.contentHash)
    || createHash('sha256').update(value.content).digest('hex') !== value.contentHash) throw new Error('Invalid chat archive record.');
  return value;
}
function validateArchivePage(value: ChatResourceArchivePage, limit: number): ChatResourceArchivePage {
  if (!value || !Array.isArray(value.items) || value.items.length > limit || (value.nextCursor !== null
    && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2048))) throw new Error('Invalid chat archive page.');
  const seen = new Set<string>();
  for (const item of value.items) {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid chat archive page.');
    boundedId(item.resourceId, 'archive resource ID');
    if (!validRevision(item.revision) || typeof item.savedAt !== 'string' || !Number.isFinite(Date.parse(item.savedAt))
      || !/^[0-9a-f]{64}$/.test(item.contentHash) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0
      || item.byteLength > CHAT_RESOURCE_IMAGE_LIMIT + MAX_NOTE_TEXT * 2 || seen.has(item.resourceId)) throw new Error('Invalid chat archive page.');
    seen.add(item.resourceId);
  }
  return value;
}

/** Main-owned, explicitly triggered LINE resource reads and native-store archive writes. */
export class ChatResourceArchiveService {
  private readonly notificationFlights = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  private readonly queued: AdmissionTask[] = [];
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly activeTasks = new Map<string, Set<AdmissionTask>>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly albumFlights = new Map<string, Promise<AlbumOpenResult>>();
  private readonly admissionWaiters = new Set<() => void>();
  private readonly accountGeneration = new Map<string, number>();
  private readonly closedAccounts = new Set<string>();
  private readonly albumOpenByteLimit: number;
  private stopped = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly deps: ChatResourceArchiveDependencies) {
    const configuredLimit = deps.albumOpenByteLimit ?? CHAT_RESOURCE_ALBUM_OPEN_BYTE_LIMIT;
    this.albumOpenByteLimit = Number.isSafeInteger(configuredLimit) && configuredLimit >= 0
      ? Math.min(configuredLimit, CHAT_RESOURCE_ALBUM_OPEN_BYTE_LIMIT) : CHAT_RESOURCE_ALBUM_OPEN_BYTE_LIMIT;
  }

  dispatchIpc(request: ChatResourceIpcRequest & { type: 'listChatNotes' }, signal?: AbortSignal): Promise<{ notes: NoteDto[]; nextCursor: string | null }>;
  dispatchIpc(request: ChatResourceIpcRequest & { type: 'getChatNote' }, signal?: AbortSignal): Promise<{ note: NoteDto }>;
  dispatchIpc(request: ChatResourceIpcRequest & { type: 'listChatAlbums' }, signal?: AbortSignal): Promise<{ albums: AlbumDto[]; nextCursor: string | null }>;
  dispatchIpc(request: ChatResourceIpcRequest & { type: 'listChatAlbumPhotos' }, signal?: AbortSignal): Promise<{ photos: PhotoDto[]; nextCursor: string | null }>;
  dispatchIpc(request: ChatResourceIpcRequest & { type: 'downloadChatAlbumPhoto' }, signal?: AbortSignal): Promise<{ albumId: string; photoId: string; sizeBytes: number }>;
  dispatchIpc(request: ChatResourceIpcRequest & { type: 'openChatAlbum' }, signal?: AbortSignal): Promise<AlbumOpenResult>;
  async dispatchIpc(request: ChatResourceIpcRequest, signal?: AbortSignal): Promise<{ notes: NoteDto[]; nextCursor: string | null } | { note: NoteDto }
    | { albums: AlbumDto[]; nextCursor: string | null } | { photos: PhotoDto[]; nextCursor: string | null }
    | { albumId: string; photoId: string; sizeBytes: number } | AlbumOpenResult> {
    const key = chatResourceConversationKey(request);
    if (request.type === 'listChatNotes') return this.listNotes(key, request.cursor ?? null, signal);
    if (request.type === 'getChatNote') return { note: await this.getNote(key, request.postId ?? '', signal) };
    if (request.type === 'listChatAlbums') return this.listAlbums(key, request.cursor ?? null, signal, 'modal', undefined, request.refresh === true);
    if (request.type === 'listChatAlbumPhotos') return this.listAlbumPhotos(key, request.albumId ?? '', request.cursor ?? null, signal, request.refresh === true);
    if (request.type === 'downloadChatAlbumPhoto') return this.downloadAlbumPhoto(key, request.albumId ?? '', request.photoId ?? '', request.oid ?? '', request.prefix ?? '', signal);
    if (request.type === 'openChatAlbum') return this.openAlbum(key, request.albumId ?? '', signal);
    throw new Error('Unsupported chat resource request.');
  }

  /** Immediately invalidates accepted work for this account; safe to call before asynchronous lifecycle handling. */
  invalidateAccount(accountId: string, reason = 'The account binding changed.'): void {
    this.closedAccounts.add(accountId);
    this.accountGeneration.set(accountId, (this.accountGeneration.get(accountId) ?? 0) + 1);
    const error = new Error(reason);
    for (let index = this.queued.length - 1; index >= 0; index--) {
      const task = this.queued[index]!;
      if (task.key.accountId !== accountId) continue;
      this.queued.splice(index, 1);
      if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener);
      task.reject(error);
    }
    for (const task of this.activeTasks.get(accountId) ?? []) { task.controller.abort(error); task.settleReject(error); }
    this.releaseAdmissionWaiters();
    this.pump();
  }

  /** Reopens reads only after the facade verifies a fresh authenticated, ready binding. */
  reopenAccount(accountId: string): void {
    if (!this.stopped) this.closedAccounts.delete(accountId);
  }

  /** Coalesces a chat's notifications into the active refresh plus one dirty trailing refresh at a time. */
  refreshNotesFromNotification(key: ConversationKey): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const id = `${key.accountId}\0${key.chatType}\0${key.chatId}`;
    const existing = this.notificationFlights.get(id);
    if (existing) { existing.dirty = true; return existing.promise; }
    if (this.notificationFlights.size >= 32) return Promise.resolve();
    const flight = { dirty: false, promise: Promise.resolve() };
    flight.promise = (async () => {
      do {
        flight.dirty = false;
        try { await this.listNotes(key, null, undefined, 'notification'); }
        catch (error) {
          if (!this.stopped && error instanceof Error && error.message === 'Chat resource service is busy.') {
            flight.dirty = true;
            await this.whenAdmissionAvailable();
          }
        }
      } while (flight.dirty && !this.stopped);
    })().finally(() => this.notificationFlights.delete(id));
    this.notificationFlights.set(id, flight);
    return flight.promise;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.stopped) {
      this.stopped = true;
      const reason = new Error('Chat resource service is shutting down.');
      for (const [accountId, tasks] of this.activeTasks) {
        for (const task of tasks) { task.controller.abort(reason); task.settleReject(reason); }
        this.activeTasks.delete(accountId);
      }
      for (const controllers of this.activeControllers.values()) for (const controller of controllers) controller.abort(reason);
      for (const task of this.queued.splice(0)) { if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener); task.reject(reason); }
      for (const resolve of this.admissionWaiters) resolve();
      this.admissionWaiters.clear();
    }
    this.shutdownPromise = (async () => {
      // close must begin before draining so the native owner can cancel outstanding IO.
      let closing: Promise<void>;
      try { closing = Promise.resolve(this.deps.store?.close()); }
      catch (error) { closing = Promise.reject(error); }
      const draining = Promise.allSettled([...this.activeRuns]);
      const first = await Promise.all([settlesWithin(closing, ARCHIVE_SHUTDOWN_GRACE_MS), settlesWithin(draining, ARCHIVE_SHUTDOWN_GRACE_MS)]);
      if (!first.every(Boolean)) {
        try { this.deps.store?.forceClose(); } catch { /* owner termination is best effort; shutdown remains bounded */ }
        await Promise.all([settlesWithin(closing, ARCHIVE_FORCE_CLOSE_GRACE_MS), settlesWithin(draining, ARCHIVE_FORCE_CLOSE_GRACE_MS)]);
      }
    })();
    return this.shutdownPromise;
  }

  async listNotes(key: ConversationKey, cursor: string | null, signal?: AbortSignal, source: 'modal' | 'notification' = 'modal') {
    return this.admit(key, signal, (operationSignal, generation) => this.listNotesImpl(key, cursor, operationSignal, generation, source));
  }
  private async listNotesImpl(key: ConversationKey, cursor: string | null, signal: AbortSignal, generation: number, source: 'modal' | 'notification' = 'modal') {
    const { value, binding } = await this.read(key, 'listNotes', { cursor, limit: CHAT_RESOURCE_PAGE_LIMIT }, signal, generation, source);
    const page = arrayResult<unknown>(value, 'notes', CHAT_RESOURCE_PAGE_LIMIT);
    const notes = page.rows.map(noteDto);
    for (const note of notes) await this.publish(key, 'note', note.postId, noteMarkdown(note), signal, generation, binding);
    this.assertCurrent(key.accountId, generation, binding, signal);
    return { notes, nextCursor: page.nextCursor };
  }

  async getNote(key: ConversationKey, postId: string, signal?: AbortSignal) {
    return this.admit(key, signal, (operationSignal, generation) => this.getNoteImpl(key, postId, operationSignal, generation));
  }
  private async getNoteImpl(key: ConversationKey, postId: string, signal: AbortSignal, generation: number) {
    const id = boundedId(postId, 'post ID');
    const { value, binding } = await this.read(key, 'getNote', { postId: id }, signal, generation);
    const note = noteDto((value as { note?: unknown })?.note);
    if (note.postId !== id) throw new Error('LINE returned a different note.');
    await this.publish(key, 'note', note.postId, noteMarkdown(note), signal, generation, binding);
    this.assertCurrent(key.accountId, generation, binding, signal);
    return note;
  }

  async listAlbums(key: ConversationKey, cursor: string | null, signal?: AbortSignal, source: 'modal' | 'notification' = 'modal', expectedBinding?: ChatResourceBinding, refresh = false) {
    return this.admit(key, signal, (operationSignal, generation) => this.listAlbumsImpl(key, cursor, operationSignal, generation, source, expectedBinding, refresh));
  }
  private async listAlbumsImpl(key: ConversationKey, cursor: string | null, signal: AbortSignal, generation: number, source: 'modal' | 'notification', expectedBinding?: ChatResourceBinding, refresh = false) {
    const catalog = this.deps.catalog;
    const catalogCursor = decodeCatalogCursor(cursor, 'db-album:');
    if (source === 'modal' && catalog && (cursor === null || catalogCursor !== null)) {
      const requestBinding = await this.authorize(key, signal, generation, expectedBinding);
      let scan = await catalog.albumScanState(key);
      if (refresh || scan.generation === 0) {
        const listGeneration = await catalog.beginAlbumScan(key, requestBinding);
        scan = { complete: false, generation: listGeneration, cursor: null, previousCursor: null, nextOrdinal: 0 };
      }
      if (catalogCursor && catalogCursor.generation !== scan.generation) throw new Error('Album catalog cursor belongs to an expired scan. Refresh the list.');
      if (!scan.complete) {
        const seen = new Set<string>();
        let lineCursor = scan.cursor;
        for (let pageIndex = 0; pageIndex < MAX_ALBUM_OPEN_PAGES; pageIndex += 1) {
          if (lineCursor !== null) seen.add(lineCursor);
          const { value, binding } = await this.read(key, 'listAlbums', { cursor: lineCursor, limit: CHAT_RESOURCE_PAGE_LIMIT }, signal, generation, 'modal', requestBinding);
          const page = arrayResult<unknown>(value, 'albums', CHAT_RESOURCE_PAGE_LIMIT);
          const albums = page.rows.map((row) => albumDto(row, key.chatId));
          for (const album of albums) await this.publish(key, 'album', album.albumId, contentBytes({ _linejsGenerated: 'album-v1', ...album }, MAX_METADATA_TEXT * 2), signal, generation, binding);
          if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new Error('Album list scan exceeded its bounded page sequence.');
          await catalog.appendAlbumPage(key, scan.generation, lineCursor, albums, page.nextCursor, binding);
          this.assertCurrent(key.accountId, generation, binding, signal);
          lineCursor = page.nextCursor;
          scan = { ...scan, cursor: lineCursor, previousCursor: lineCursor === null ? (seen.size ? [...seen].at(-1)! : null) : null,
            nextOrdinal: scan.nextOrdinal + albums.length, complete: lineCursor === null };
          if (scan.complete) break;
        }
      }
      if (catalogCursor && catalogCursor.ordinal >= scan.nextOrdinal && catalogCursor.ordinal !== -1) throw new Error('Album catalog cursor is ahead of the current scan.');
      const after = catalogCursor?.ordinal.toString() ?? null;
      const page = await catalog.listAlbums(key, after, CHAT_RESOURCE_PAGE_LIMIT);
      this.assertCurrent(key.accountId, generation, requestBinding, signal);
      const covers = catalog.firstPhotoIds ? await catalog.firstPhotoIds(key, page.items.map(({ albumId }) => albumId), 2) : new Map<string, string[]>();
      const albums = page.items.map((album) => ({ ...album, coverPhotoIds: covers.get(album.albumId) ?? [] }));
      const nextOrdinal = page.nextCursor === null ? scan.nextOrdinal - 1 : Number(page.nextCursor);
      const nextCursor = page.nextCursor !== null || !scan.complete ? encodeCatalogCursor('db-album:', scan.generation, nextOrdinal) : null;
      return { albums, nextCursor };
    }
    const { value, binding } = await this.read(key, 'listAlbums', { cursor, limit: CHAT_RESOURCE_PAGE_LIMIT }, signal, generation, source, expectedBinding);
    const page = arrayResult<unknown>(value, 'albums', CHAT_RESOURCE_PAGE_LIMIT);
    const albums = page.rows.map((row) => albumDto(row, key.chatId));
    for (const album of albums) await this.publish(key, 'album', album.albumId, contentBytes({ _linejsGenerated: 'album-v1', ...album }, MAX_METADATA_TEXT * 2), signal, generation, binding);
    if (source === 'notification' && this.deps.catalog) {
      const scan = cursor === null ? null : await this.deps.catalog.albumScanState(key);
      const listGeneration = cursor === null ? await this.deps.catalog.beginAlbumScan(key, binding) : scan?.generation ?? 0;
      await this.deps.catalog.appendAlbumPage(key, listGeneration, cursor, albums, page.nextCursor, binding);
    }
    this.assertCurrent(key.accountId, generation, binding, signal);
    return { albums, nextCursor: page.nextCursor };
  }

  async listAlbumPhotos(key: ConversationKey, albumId: string, cursor: string | null, signal?: AbortSignal, refresh = false) {
    return this.admit(key, signal, (operationSignal, generation) => this.listAlbumPhotosImpl(key, albumId, cursor, operationSignal, generation, refresh));
  }

  async readSavedAlbumPhoto(key: ConversationKey, albumId: string, photoId: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    return this.admit(key, signal, async (operationSignal, generation) => {
      const id = boundedId(albumId, 'album ID'), pid = boundedId(photoId, 'photo ID');
      const binding = await this.authorize(key, operationSignal, generation);
      const catalog = this.deps.catalog, store = this.deps.store;
      if (!catalog?.savedPhoto || !store?.readAlbumPhoto) return null;
      const saved = await catalog.savedPhoto(key, id, pid);
      if (!saved) return null;
      const archived = await store.readAlbumPhoto({ key, albumId: id, photoId: pid, signal: operationSignal,
        guard: () => this.assertCurrent(key.accountId, generation, binding, operationSignal) });
      this.assertCurrent(key.accountId, generation, binding, operationSignal);
      if (!archived || !sameAlbumSavedFile(saved, archived)) return null;
      const bytes = archived.content;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== saved.byteCount) return null;
      const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
        : bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? 'image/png'
        : new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP' ? 'image/webp'
        : ['GIF87a', 'GIF89a'].includes(new TextDecoder().decode(bytes.subarray(0, 6))) ? 'image/gif' : null;
      return mimeType ? { bytes, mimeType } : null;
    });
  }
  private async listAlbumPhotosImpl(key: ConversationKey, albumId: string, cursor: string | null, signal: AbortSignal, generation: number, refresh = false) {
    const id = boundedId(albumId, 'album ID');
    const catalog = this.deps.catalog;
    const catalogCursor = decodeCatalogCursor(cursor, 'db-photo:');
    if (catalog && (cursor === null || catalogCursor !== null)) {
      const requestBinding = await this.authorize(key, signal, generation);
      let scan = await catalog.photoScan(key, id);
      if (refresh || !scan || scan.generation === 0) {
        const photoGeneration = await catalog.beginPhotoScan(key, id, requestBinding);
        scan = { complete: false, generation: photoGeneration, cursor: null, previousCursor: null, nextOrdinal: 0 };
      }
      if (catalogCursor && catalogCursor.generation !== scan.generation) throw new Error('Album photo cursor belongs to an expired scan. Refresh the album.');
      if (!scan.complete) {
        const photoGeneration = scan.generation;
        const seen = new Set<string>();
        let lineCursor = scan.cursor;
        for (let pageIndex = 0; pageIndex < MAX_ALBUM_OPEN_PAGES; pageIndex += 1) {
          if (pageIndex > 0 && lineCursor === null) break;
          if (lineCursor !== null && seen.has(lineCursor)) throw new Error('Album photo scan exceeded its bounded page sequence.');
          if (lineCursor !== null) seen.add(lineCursor);
          const { value, binding } = await this.read(key, 'listAlbumPhotos', { albumId: id, cursor: lineCursor, limit: CHAT_RESOURCE_PHOTO_LIMIT }, signal, generation, 'modal', requestBinding);
          const page = arrayResult<unknown>(value, 'photos', CHAT_RESOURCE_PHOTO_LIMIT);
          const photos = page.rows.map(photoDto);
          const content = contentBytes({ _linejsGenerated: 'album-photos-v1', albumId: id, cursor: lineCursor, nextCursor: page.nextCursor, photos }, MAX_METADATA_TEXT * 20);
          await this.publish(key, 'photo-page', chatResourcePhotoPageId(id, lineCursor), content, signal, generation, binding);
          if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new Error('Album photo scan exceeded its bounded page sequence.');
          await catalog.appendPhotoPage(key, id, photoGeneration, lineCursor, photos, page.nextCursor, binding);
          this.assertCurrent(key.accountId, generation, binding, signal);
          lineCursor = page.nextCursor;
          scan = { ...scan, complete: lineCursor === null, generation: photoGeneration, cursor: lineCursor,
            previousCursor: lineCursor === null ? (seen.size ? [...seen].at(-1)! : null) : null, nextOrdinal: scan.nextOrdinal + photos.length };
          if (scan.complete) break;
        }
      }
      if (catalogCursor && catalogCursor.ordinal >= scan.nextOrdinal && catalogCursor.ordinal !== -1) throw new Error('Album photo cursor is ahead of the current scan.');
      const page = await catalog.listPhotos(key, id, catalogCursor?.ordinal.toString() ?? null, CHAT_RESOURCE_PHOTO_LIMIT);
      this.assertCurrent(key.accountId, generation, requestBinding, signal);
      const nextOrdinal = page.nextCursor === null ? scan.nextOrdinal - 1 : Number(page.nextCursor);
      const nextCursor = page.nextCursor !== null || !scan.complete ? encodeCatalogCursor('db-photo:', scan.generation, nextOrdinal) : null;
      return { photos: page.items, nextCursor };
    }
    const { value, binding } = await this.read(key, 'listAlbumPhotos', { albumId: id, cursor, limit: CHAT_RESOURCE_PHOTO_LIMIT }, signal, generation);
    const page = arrayResult<unknown>(value, 'photos', CHAT_RESOURCE_PHOTO_LIMIT);
    const photos = page.rows.map(photoDto);
    const content = contentBytes({ _linejsGenerated: 'album-photos-v1', albumId: id, cursor, nextCursor: page.nextCursor, photos }, MAX_METADATA_TEXT * 20);
    await this.publish(key, 'photo-page', chatResourcePhotoPageId(id, cursor), content, signal, generation, binding);
    this.assertCurrent(key.accountId, generation, binding, signal);
    return { photos, nextCursor: page.nextCursor };
  }

  async downloadAlbumPhoto(key: ConversationKey, albumId: string, photoId: string, oid: string, prefix: string, signal?: AbortSignal) {
    return this.admit(key, signal, (operationSignal, generation) => this.downloadAlbumPhotoImpl(key, albumId, photoId, oid, prefix, operationSignal, generation));
  }

  openAlbum(key: ConversationKey, albumId: string, signal?: AbortSignal, source: 'modal' | 'notification' = 'modal', expectedBinding?: ChatResourceBinding,
    startCursor: string | null = null, startPhotoIndex = 0): Promise<AlbumOpenResult> {
    const id = boundedId(albumId, 'album ID');
    const flightKey = `${key.accountId}\0${key.chatType}\0${key.chatId}\0${id}`;
    const current = this.albumFlights.get(flightKey);
    if (current) {
      if (source === 'notification') return current.then(() => this.openAlbum(key, id, signal, source, expectedBinding, startCursor, startPhotoIndex));
      return Promise.reject(new Error('ALBUM_ARCHIVE_ALREADY_RUNNING'));
    }
    const flight = this.admit(key, signal, (operationSignal, generation) => this.openAlbumImpl(key, id, operationSignal, generation, source, expectedBinding, startCursor, startPhotoIndex))
      .finally(() => { if (this.albumFlights.get(flightKey) === flight) this.albumFlights.delete(flightKey); });
    this.albumFlights.set(flightKey, flight);
    return flight;
  }

  private async openAlbumImpl(key: ConversationKey, albumId: string, signal: AbortSignal, generation: number,
    source: 'modal' | 'notification', expectedBinding?: ChatResourceBinding, startCursor: string | null = null, startPhotoIndex = 0): Promise<AlbumOpenResult> {
    const firstBinding = await this.authorize(key, signal, generation, expectedBinding);
    const store = this.store();
    if (!store.ensureAlbumFolder || !store.publishAlbumPhoto) throw new Error('ALBUM_FOLDER_ARCHIVE_UNAVAILABLE');
    const guard = () => this.assertCurrent(key.accountId, generation, firstBinding, signal);
    guard();
    const catalog = this.deps.catalog;
    let photoCatalogGeneration: number | null = null;
    let mayCompletePhotoScan = false;
    if (catalog) {
      if (startCursor === null) {
        photoCatalogGeneration = await catalog.beginPhotoScan(key, albumId, firstBinding);
        mayCompletePhotoScan = true;
      } else {
        const currentScan = await catalog.photoScan(key, albumId);
        if (currentScan) {
          photoCatalogGeneration = currentScan.generation;
          mayCompletePhotoScan = (!currentScan.complete && currentScan.cursor === startCursor) || currentScan.previousCursor === startCursor;
        }
      }
    }
    let cursor: string | null = startCursor;
    const seenCursors = new Set<string>();
    const seenPhotos = new Set<string>();
    let savedCount = 0, failedCount = 0, totalBytes = 0, itemCount = 0;
    const failureCodes: string[] = [];
    let complete = true;
    let stopCode: string | null = null;
    let failureContext: AlbumFailureContext | undefined;
    let pageCount = 0;
    let nextPhotoIndex = 0;
    do {
      guard();
      if (pageCount >= MAX_ALBUM_OPEN_PAGES) { complete = false; stopCode = 'PAGE_LIMIT'; break; }
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          complete = false; stopCode = 'CURSOR_LOOP';
          failureContext = { action: 'album_photos', stage: 'pagination', code: 'ALBUM_PHOTO_CURSOR_LOOP' };
          break;
        }
        seenCursors.add(cursor);
      }
      let page: { value: ChatResourceReadResult; binding: ChatResourceBinding };
      try { page = await this.read(key, 'listAlbumPhotos', { albumId, cursor, limit: CHAT_RESOURCE_PHOTO_LIMIT }, signal, generation, source, firstBinding); }
      catch (error) {
        complete = false; stopCode = archiveFailureCode(error);
        failureContext = { action: 'album_photos', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' };
        break;
      }
      pageCount += 1;
      let rows: PhotoDto[];
      try { rows = arrayResult<unknown>(page.value, 'photos', CHAT_RESOURCE_PHOTO_LIMIT).rows.map(photoDto); }
      catch (error) {
        complete = false; stopCode = archiveFailureCode(error);
        failureContext = { action: 'album_photos', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' };
        break;
      }
      if (catalog && photoCatalogGeneration !== null && mayCompletePhotoScan) {
        await catalog.appendPhotoPage(key, albumId, photoCatalogGeneration, cursor, rows, page.value.nextCursor ?? null, page.binding);
      }
      let photoIndex = 0;
      if (pageCount === 1) {
        const folderStartedAt = Date.now();
        try { guard(); await store.ensureAlbumFolder({ key, albumId, signal, guard }); }
        catch (error) {
          this.logDiagnostic({ source, accountId: key.accountId, chatId: key.chatId, albumId, action: 'album_photos',
            occurredAt: new Date(folderStartedAt).toISOString(), durationMs: Date.now() - folderStartedAt, status: 'failure', errorCode: 'UNKNOWN',
            failureStage: 'archive_write', failureReason: 'folder_write_failed', failureCategory: 'unknown', itemCount: 0, byteCount: 0, responseFields: [] });
          markChatResourceDiagnosticLogged(error);
          const failure = new AlbumArchiveFailure({ action: 'album_photos', stage: 'archive_write', code: 'ALBUM_ARCHIVE_INCOMPLETE' });
          markChatResourceDiagnosticLogged(failure);
          throw failure;
        }
      }
      for (const photo of rows) {
        const currentPhotoIndex = photoIndex++;
        if (pageCount === 1 && currentPhotoIndex < startPhotoIndex) continue;
        guard();
        if (seenPhotos.has(photo.photoId)) continue;
        if (itemCount >= CHAT_RESOURCE_ALBUM_OPEN_ITEM_LIMIT) { complete = false; stopCode = 'PAGE_LIMIT'; nextPhotoIndex = currentPhotoIndex; break; }
        seenPhotos.add(photo.photoId); itemCount += 1;
        const remainingBytes = this.albumOpenByteLimit - totalBytes;
        if (remainingBytes <= 0) { complete = false; stopCode = 'BYTE_LIMIT'; nextPhotoIndex = currentPhotoIndex; break; }
        let failureStage: 'archive_contains' | 'resource_read' | 'archive_write' = 'archive_contains';
        try {
          const saved = catalog?.savedPhoto ? await catalog.savedPhoto(key, albumId, photo.photoId) : null;
          const existing = store.inspectAlbumPhoto
            ? await store.inspectAlbumPhoto({ key, albumId, photoId: photo.photoId, signal, guard })
            : null;
          if (existing) {
            if (catalog && !sameAlbumSavedFile(saved, existing)) await catalog.savePhoto(key, albumId, photo.photoId, existing, firstBinding);
            guard(); savedCount += 1; continue;
          }
          if (!store.inspectAlbumPhoto && store.hasAlbumPhoto && await store.hasAlbumPhoto({ key, albumId, photoId: photo.photoId, signal, guard })) {
            guard(); savedCount += 1; continue;
          }
          failureStage = 'resource_read';
          const { value, binding } = await this.read(key, 'downloadAlbumPhoto', { albumId, photoId: photo.photoId, oid: photo.oid,
            prefix: photo.prefix, maxBytes: Math.min(CHAT_RESOURCE_IMAGE_LIMIT, remainingBytes) }, signal, generation, source, firstBinding);
          guard();
          const image = value.bytes;
          if (image instanceof Uint8Array) totalBytes += image.byteLength;
          if (!(image instanceof Uint8Array) || image.byteLength < 1 || image.byteLength > CHAT_RESOURCE_IMAGE_LIMIT) throw new Error('INVALID_IMAGE');
          if (image.byteLength > remainingBytes) {
            failedCount += 1;
            failureCodes.push('BYTE_LIMIT');
            this.recordAlbumPhotoOutcome(key, 'failed');
            complete = false; stopCode = 'BYTE_LIMIT'; nextPhotoIndex = currentPhotoIndex; break;
          }
          guard();
          failureStage = 'archive_write';
          const archived = await store.publishAlbumPhoto({ key, albumId, photoId: photo.photoId, content: image, signal, guard: () => this.assertCurrent(key.accountId, generation, binding, signal) });
          if (catalog && archived) await catalog.savePhoto(key, albumId, photo.photoId, archived, binding);
          guard(); savedCount += 1;
          this.recordAlbumPhotoOutcome(key, 'succeeded');
        } catch (error) {
          this.recordAlbumPhotoOutcome(key, 'failed');
          const failureCode = archiveFailureCode(error);
          failureContext ??= failureStage === 'resource_read'
            ? { action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' }
            : failureStage === 'archive_write'
              ? { action: 'album_photos', stage: 'archive_write', code: 'ALBUM_ARCHIVE_INCOMPLETE' }
              : { action: 'album_photos', stage: 'archive_contains', code: 'ALBUM_RECONCILIATION_FAILED' };
          if (failureStage === 'archive_write') this.logDiagnostic({ source, accountId: key.accountId, chatId: key.chatId, albumId,
            action: 'album_photos', occurredAt: new Date().toISOString(), durationMs: 0, status: 'failure', errorCode: 'UNKNOWN',
            failureStage: 'archive_write', failureReason: 'photo_write_failed', failureCategory: 'unknown', itemCount: 1,
            byteCount: 0, responseFields: [] });
          else if (failureStage === 'archive_contains') this.logDiagnostic({ source, accountId: key.accountId, chatId: key.chatId, albumId,
            action: 'album_photos', occurredAt: new Date().toISOString(), durationMs: 0, status: 'failure', errorCode: 'UNKNOWN',
            failureStage: 'archive_contains', failureReason: 'unknown', failureCategory: 'unknown', itemCount: 1,
            byteCount: 0, responseFields: [] });
          else if (!wasChatResourceDiagnosticLogged(error)) this.logDiagnostic({ source, accountId: key.accountId, chatId: key.chatId, albumId,
            action: 'photo_download', occurredAt: new Date().toISOString(), durationMs: 0, status: 'failure', errorCode: diagnosticErrorCode(error),
            failureStage: 'resource_read', failureReason: error instanceof Error && error.message.toLowerCase().includes('binding changed') ? 'stale_binding' : 'unknown',
            failureCategory: 'unknown', itemCount: 1, byteCount: 0, responseFields: [] });
          if (signal.aborted || generation !== (this.accountGeneration.get(key.accountId) ?? 0)
            || this.stopped || !this.deps.isCurrentBinding(firstBinding)
            || ['REPARSE_POINT', 'CHAT_IDENTITY_CHANGED', 'CHAT_FOLDER_UNAVAILABLE', 'CLOSED', 'ABORTED'].includes(failureCode)) {
            complete = false; stopCode = failureCode; break;
          }
          failedCount += 1;
          failureCodes.push(failureCode);
        }
      }
      if (stopCode) break;
      cursor = page.value.nextCursor ?? null;
    } while (cursor !== null);
    guard();
    return { albumId, savedCount, failedCount, totalCount: itemCount, byteCount: totalBytes, complete: complete && failedCount === 0,
      failureCodes: failureCodes.slice(0, CHAT_RESOURCE_ALBUM_OPEN_ITEM_LIMIT), errorCode: stopCode,
      nextCursor: stopCode === 'PAGE_LIMIT' || stopCode === 'BYTE_LIMIT' ? cursor : null, nextPhotoIndex,
      ...(failureContext ? { failureContext } : {}) };
  }
  private async downloadAlbumPhotoImpl(key: ConversationKey, albumId: string, photoId: string, oid: string, prefix: string, signal: AbortSignal, generation: number) {
    const aid = boundedId(albumId, 'album ID');
    const pid = boundedId(photoId, 'photo ID');
    const objectId = boundedId(oid, 'photo object ID');
    const photoPrefix = boundedText(prefix, 512, 'photo prefix');
    if (photoPrefix !== 'album/a' && photoPrefix !== 'album/v') throw new Error('Invalid photo prefix.');
    const store = this.store();
    if (!store.inspectAlbumPhoto || !store.publishAlbumPhoto) throw new Error('ALBUM_PHOTO_ARCHIVE_INSPECTION_UNAVAILABLE');
    const binding = await this.authorize(key, signal, generation);
    const guard = () => this.assertCurrent(key.accountId, generation, binding, signal);
    guard();
    const saved = await this.deps.catalog?.savedPhoto(key, aid, pid) ?? null;
    const existing = await store.inspectAlbumPhoto({ key, albumId: aid, photoId: pid, signal, guard });
    guard();
    if (existing) {
      if (!sameAlbumSavedFile(saved, existing)) await this.deps.catalog?.savePhoto(key, aid, pid, existing, binding);
      guard();
      return { albumId: aid, photoId: pid, sizeBytes: sameAlbumSavedFile(saved, existing) ? saved!.byteCount : existing.byteCount };
    }
    if (saved) await this.deps.catalog?.clearSavedPhoto(key, aid, pid, binding);
    guard();
    const { value, binding: readBinding } = await this.read(key, 'downloadAlbumPhoto', { albumId: aid, photoId: pid, oid: objectId,
      prefix: photoPrefix, maxBytes: CHAT_RESOURCE_IMAGE_LIMIT }, signal, generation, 'modal', binding);
    const image = (value as { bytes?: unknown })?.bytes;
    if (!(image instanceof Uint8Array) || image.byteLength < 1 || image.byteLength > CHAT_RESOURCE_IMAGE_LIMIT) throw new Error('Invalid or oversized album image.');
    const archived = await store.publishAlbumPhoto({ key, albumId: aid, photoId: pid, content: image, signal,
      guard: () => this.assertCurrent(key.accountId, generation, readBinding, signal) });
    if (!archived) throw new Error('ALBUM_PHOTO_ARCHIVE_METADATA_UNAVAILABLE');
    await this.deps.catalog?.savePhoto(key, aid, pid, archived, readBinding);
    this.assertCurrent(key.accountId, generation, readBinding, signal);
    return { albumId: aid, photoId: pid, sizeBytes: image.byteLength };
  }

  async listArchived(key: ConversationKey, kind: ChatResourceKind, cursor: string | null, signal?: AbortSignal, limit = CHAT_RESOURCE_PAGE_LIMIT): Promise<ChatResourceArchivePage> {
    return this.admit(key, signal, async (operationSignal, generation) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_RESOURCE_PAGE_LIMIT) throw new Error('Invalid chat resource archive limit.');
      const binding = await this.authorize(key, operationSignal, generation);
      const page = validateArchivePage(await this.store().list({ key, kind, limit, cursor, signal: operationSignal }), limit);
      this.assertCurrent(key.accountId, generation, binding, operationSignal);
      return page;
    });
  }

  async readArchived(key: ConversationKey, kind: ChatResourceKind, resourceId: string, signal?: AbortSignal): Promise<ChatResourceArchiveVersion | null> {
    return this.admit(key, signal, async (operationSignal, generation) => {
      const id = boundedId(resourceId, 'resource ID');
      const binding = await this.authorize(key, operationSignal, generation);
      const result = await this.store().read({ key, kind, resourceId: id, signal: operationSignal });
      this.assertCurrent(key.accountId, generation, binding, operationSignal);
      return result ? validateArchiveVersion(result) : null;
    });
  }

  recordNotificationFailure(key: ConversationKey, error: unknown): void {
    if (wasChatResourceDiagnosticLogged(error)) return;
    const context = albumFailureContextFrom(error) ?? { action: 'album_list' as const, stage: 'archive_scan' as const,
      code: error instanceof Error && error.message === 'ALBUM_ARCHIVE_INCOMPLETE' ? 'ALBUM_ARCHIVE_INCOMPLETE' as const : 'ALBUM_RECONCILIATION_FAILED' as const };
    this.logDiagnostic({ source: 'notification', accountId: key.accountId, chatId: key.chatId, action: context.action,
      occurredAt: new Date().toISOString(), durationMs: 0, status: 'failure', errorCode: diagnosticErrorCode(error),
      failureStage: context.stage === 'pagination' ? 'photo_pagination' : context.stage,
      failureReason: context.stage === 'pagination' ? 'cursor_loop' : context.stage === 'archive_write' ? 'photo_write_failed'
        : error instanceof Error && error.message === 'ALBUM_ARCHIVE_INCOMPLETE' ? 'archive_incomplete'
        : context.stage === 'archive_scan' ? 'archive_reconciliation_failed' : context.stage === 'resource_read' ? 'worker_response_error' : 'unknown',
      failureCategory: 'unknown', itemCount: 0, byteCount: 0, responseFields: [] });
    markChatResourceDiagnosticLogged(error);
  }

  private admit<T>(key: ConversationKey, signal: AbortSignal | undefined,
    run: (signal: AbortSignal, generation: number) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Chat resource service is shutting down.'));
    if (this.closedAccounts.has(key.accountId)) return Promise.reject(new Error('The account archive is closed until LINE login is ready.'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Chat resource read cancelled.'));
    if (this.queued.length >= MAX_ARCHIVE_PENDING) return Promise.reject(new Error('Chat resource service is busy.'));
    const generation = this.accountGeneration.get(key.accountId) ?? 0;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: unknown) => { if (settled) return; settled = true; resolve(value as T); };
      const settleReject = (reason: unknown) => { if (settled) return; settled = true; reject(reason); };
      const task: AdmissionTask = { key, generation, controller: new AbortController(), signal, run,
        resolve: settleResolve, reject: settleReject, settleReject, abortListener: undefined };
      task.abortListener = () => {
        const queuedIndex = this.queued.indexOf(task);
        if (queuedIndex >= 0) { this.queued.splice(queuedIndex, 1); settleReject(signal?.reason ?? new Error('Chat resource read cancelled.')); }
        else { const reason = signal?.reason ?? new Error('Chat resource read cancelled.'); task.controller.abort(reason); task.settleReject(reason); }
        this.pump();
      };
      signal?.addEventListener('abort', task.abortListener, { once: true });
      this.queued.push(task);
      this.pump();
    });
  }

  private pump(): void {
    this.releaseAdmissionWaiters();
    while (!this.stopped && this.activeRuns.size < MAX_ARCHIVE_ACTIVE) {
      const activeAccounts = new Set(this.activeControllers.keys());
      const index = this.queued.findIndex((task) => !activeAccounts.has(task.key.accountId));
      if (index < 0) return;
      const task = this.queued.splice(index, 1)[0]!;
      this.releaseAdmissionWaiters();
      if (task.signal?.aborted) { if (task.abortListener) task.signal.removeEventListener('abort', task.abortListener); task.reject(task.signal.reason); continue; }
      if (task.generation !== (this.accountGeneration.get(task.key.accountId) ?? 0)) {
        if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener);
        task.reject(new Error('The account binding changed.')); continue;
      }
      const controllers = this.activeControllers.get(task.key.accountId) ?? new Set<AbortController>();
      controllers.add(task.controller); this.activeControllers.set(task.key.accountId, controllers);
      const accountTasks = this.activeTasks.get(task.key.accountId) ?? new Set<AdmissionTask>();
      accountTasks.add(task); this.activeTasks.set(task.key.accountId, accountTasks);
      const run = Promise.resolve().then(() => task.run(task.controller.signal, task.generation)).then(task.resolve, task.reject).finally(() => {
        if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener);
        controllers.delete(task.controller);
        if (controllers.size === 0) this.activeControllers.delete(task.key.accountId);
        accountTasks.delete(task);
        if (accountTasks.size === 0 && this.activeTasks.get(task.key.accountId) === accountTasks) this.activeTasks.delete(task.key.accountId);
        this.activeRuns.delete(run);
        this.pump();
      });
      this.activeRuns.add(run);
    }
  }

  private releaseAdmissionWaiters(): void {
    if (this.queued.length >= MAX_ARCHIVE_PENDING && !this.stopped) return;
    for (const resolve of this.admissionWaiters) resolve();
    this.admissionWaiters.clear();
  }

  private whenAdmissionAvailable(): Promise<void> {
    if (this.stopped || this.queued.length < MAX_ARCHIVE_PENDING) return Promise.resolve();
    return new Promise((resolve) => this.admissionWaiters.add(resolve));
  }

  private assertCurrent(accountId: string, generation: number, binding: ChatResourceBinding | null, signal: AbortSignal): void {
    if (this.stopped) throw new Error('Chat resource service is shutting down.');
    if (signal.aborted) throw signal.reason ?? new Error('Chat resource read cancelled.');
    if (generation !== (this.accountGeneration.get(accountId) ?? 0)) throw new Error('The account binding changed during the LINE read.');
    if (binding && (!this.deps.isCurrentBinding(binding) || binding.mode !== 'ACTIVE_CONTROL')) throw new Error('The account binding changed during the LINE read.');
  }

  private async authorize(key: ConversationKey, signal: AbortSignal, generation: number, expectedBinding?: ChatResourceBinding): Promise<ChatResourceBinding> {
    boundedId(key.accountId, 'account ID'); boundedId(key.chatId, 'chat ID');
    if (!await this.deps.isWritableAccount(key.accountId)) throw new Error('LINE resource reads are disabled for a read-only account.');
    this.assertCurrent(key.accountId, generation, null, signal);
    if (!await this.deps.conversationExists(key)) throw new Error('The requested conversation does not belong to this account.');
    this.assertCurrent(key.accountId, generation, null, signal);
    const binding = await this.deps.getBinding(key.accountId);
    this.assertCurrent(key.accountId, generation, binding, signal);
    if (!binding || binding.accountId !== key.accountId || binding.mode !== 'ACTIVE_CONTROL' || !this.deps.isCurrentBinding(binding)) throw new Error('The account has no current logged-in worker binding.');
    if (expectedBinding && !sameChatResourceBinding(binding, expectedBinding)) throw new Error('The account binding changed during the album reconciliation.');
    return binding;
  }

  private async publish(key: ConversationKey, kind: ChatResourceKind, resourceId: string, content: Uint8Array, signal: AbortSignal,
    generation: number, binding: ChatResourceBinding): Promise<void> {
    boundedId(resourceId, 'resource ID');
    this.assertCurrent(key.accountId, generation, binding, signal);
    if (!this.deps.store) throw new Error('CHAT_RESOURCE_STORE_UNAVAILABLE');
    const stored = await this.deps.store.publish({ key, kind, resourceId, content, signal,
      guard: () => this.assertCurrent(key.accountId, generation, binding, signal) });
    this.assertCurrent(key.accountId, generation, binding, signal);
    if (!stored || !validRevision(stored.revision) || typeof stored.savedAt !== 'string' || !Number.isFinite(Date.parse(stored.savedAt))
      || stored.byteLength !== content.byteLength || stored.contentHash !== createHash('sha256').update(content).digest('hex')) throw new Error('Invalid chat archive publication result.');
  }

  private store(): ChatResourceStore { return this.deps.store ?? unavailableChatResourceStore; }

  private async read(key: ConversationKey, action: ChatResourceAction,
    extra: Omit<Pick<ChatResourceRequest, 'cursor' | 'postId' | 'albumId' | 'photoId' | 'oid' | 'prefix' | 'limit' | 'maxBytes'>, 'cursor'>
      & { cursor?: string | null }, signal: AbortSignal, generation: number, source: 'modal' | 'notification' = 'modal', expectedBinding?: ChatResourceBinding): Promise<{ value: ChatResourceReadResult; binding: ChatResourceBinding }> {
    if (extra.cursor !== undefined && extra.cursor !== null && (typeof extra.cursor !== 'string' || extra.cursor.length > 2048)) throw new Error('Invalid chat resource cursor.');
    if (!this.deps.store) throw new Error('CHAT_RESOURCE_STORE_UNAVAILABLE');
    const binding = await this.authorize(key, signal, generation, expectedBinding);
    const { cursor, ...commandOptions } = extra;
    const command: ChatResourceRequest = { type: 'chatResourceRead', accountId: key.accountId, chatType: key.chatType, chatId: key.chatId, ...commandOptions,
      ...(cursor !== undefined && cursor !== null ? { cursor } : {}), action, requestId: randomUUID(), timeoutMs: 30_000,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, transportOwnerId: binding.transportOwnerId,
      transportGeneration: binding.transportGeneration, writeGrantVersion: binding.writeGrantVersion };
    const startedAt = Date.now();
    const occurredAt = new Date(startedAt).toISOString();
    let response: ChatResourceReadResult;
    try { response = await this.deps.readChatResource(command, signal); }
    catch (error) {
      const failure = diagnosticFailure(error);
      this.logDiagnostic({ source, accountId: key.accountId, chatId: key.chatId, action: diagnosticAction(action), occurredAt, correlationId: command.requestId,
        ...(typeof extra.albumId === 'string' ? { albumId: extra.albumId } : {}),
        durationMs: Date.now() - startedAt, status: 'failure', errorCode: diagnosticErrorCode(error), ...failure, itemCount: 0, byteCount: 0, responseFields: [] });
      markChatResourceDiagnosticLogged(error);
      throw error;
    }
    const responseFields = Object.entries(response).slice(0, 32).map(([name, value]) => ({ name,
      type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value }))
      .filter((field) => ['null', 'boolean', 'number', 'string', 'array', 'object'].includes(field.type));
    const rows = response.notes ?? response.albums ?? response.photos;
    let byteCount = 0;
    try { byteCount = response.bytes?.byteLength ?? Buffer.byteLength(JSON.stringify(response), 'utf8'); } catch { byteCount = 0; }
    this.logDiagnostic({ source, accountId: key.accountId, chatId: key.chatId, action: diagnosticAction(action), occurredAt, correlationId: command.requestId,
      ...(typeof extra.albumId === 'string' ? { albumId: extra.albumId } : {}),
      durationMs: Date.now() - startedAt, status: response.ok ? 'success' : 'failure',
      ...(!response.ok ? { errorCode: diagnosticErrorCode(response.error), failureStage: 'worker_response', failureReason: 'worker_response_error',
        failureCategory: chatResourceFailureCategory(response.error),
        ...(response.failureKind ? { failureKind: response.failureKind } : {}),
        ...(response.upstreamStatus === undefined ? {} : { upstreamStatus: response.upstreamStatus }),
        ...(response.upstreamCode === undefined ? {} : { upstreamCode: response.upstreamCode }),
        ...(source === 'modal' && (action === 'listNotes' || action === 'getNote') && response.error === 'response_code_invalid'
          && response.responseCode !== undefined ? { responseCode: response.responseCode } : {}),
      } : {}), ...(response.photoPageShape ? { photoPageShape: response.photoPageShape } : {}),
      itemCount: rows?.length ?? (response.note ? 1 : 0), byteCount, responseFields });
    this.assertCurrent(key.accountId, generation, binding, signal);
    if (response.type !== 'chatResourceResult' || response.requestId !== command.requestId || response.action !== action
      || response.accountId !== key.accountId || response.workerInstanceId !== binding.workerInstanceId || response.controlEpoch !== binding.controlEpoch
      || response.chatType !== key.chatType || response.chatId !== key.chatId) throw new Error('Invalid LINE resource response.');
    if (!response.ok) {
      const error = new Error(isChatResourceFailureCode(response.error) ? 'LINE_READ_FAILED' : response.error ?? 'LINE resource read failed.');
      markChatResourceDiagnosticLogged(error);
      throw error;
    }
    return { value: response, binding };
  }

  private logDiagnostic(record: unknown): void { try { this.deps.recordDiagnostic?.(record); } catch { /* diagnostics never change a read result */ } }

  private recordAlbumPhotoOutcome(key: ConversationKey, phase: 'succeeded' | 'failed'): void {
    try { this.deps.audit?.outcome('album_photo_download', phase, { initiator: 'user', accountId: key.accountId,
      correlationId: randomUUID(), requestId: randomUUID(), ...(phase === 'failed' ? { errorCode: 'CHAT_RESOURCE_READ_FAILED' } : {}) }); }
    catch { /* activity recording must not change the archive result */ }
  }
}

function chatResourceFailureCategory(value: unknown): 'bootstrap_failure' | 'list_get_transport_failure' | 'response_code_invalid' | 'response_shape_invalid'
  | 'normalization_failure' | 'response_validation' | 'timeout' | 'cancellation' | 'unknown' {
  if (value === 'TIMEOUT') return 'timeout';
  if (value === 'CANCELLED') return 'cancellation';
  return typeof value === 'string' && ['bootstrap_failure', 'list_get_transport_failure', 'response_code_invalid', 'response_shape_invalid',
    'normalization_failure', 'response_validation', 'timeout', 'cancellation', 'unknown'].includes(value)
    ? value as ReturnType<typeof chatResourceFailureCategory> : 'unknown';
}

function isChatResourceFailureCode(value: unknown): boolean {
  return typeof value === 'string' && ['bootstrap_failure', 'list_get_transport_failure', 'response_code_invalid', 'response_shape_invalid',
    'normalization_failure', 'response_validation', 'unknown'].includes(value);
}

function diagnosticAction(action: ChatResourceAction): 'note_list' | 'note_detail' | 'album_list' | 'album_photos' | 'photo_download' {
  return action === 'listNotes' ? 'note_list' : action === 'getNote' ? 'note_detail' : action === 'listAlbums' ? 'album_list'
    : action === 'listAlbumPhotos' ? 'album_photos' : 'photo_download';
}
function diagnosticFailure(error: unknown): Record<string, unknown> {
  const diagnostic = error && typeof error === 'object' ? (error as { diagnostic?: unknown }).diagnostic : undefined;
  if (!diagnostic || typeof diagnostic !== 'object') return { failureStage: 'resource_read', failureReason: 'unknown' };
  const value = diagnostic as Record<string, unknown>;
  const allowed = (field: string, values: string[]) => typeof value[field] === 'string' && values.includes(value[field] as string);
  if (!allowed('stage', ['gateway_admission', 'pending_request', 'worker_response'])
    || !allowed('reason', ['missing_worker', 'not_ready_worker', 'stale_binding', 'pending_stopped', 'worker_response_error', 'unknown'])) {
    return { failureStage: 'resource_read', failureReason: 'unknown' };
  }
  return { failureStage: value.stage, failureReason: value.reason,
    ...(typeof value.currentBindingMatch === 'boolean' ? { currentBindingMatch: value.currentBindingMatch } : {}),
    ...(typeof value.currentEpochMatch === 'boolean' ? { currentEpochMatch: value.currentEpochMatch } : {}),
    ...(typeof value.workerReady === 'boolean' ? { workerReady: value.workerReady } : {}) };
}
function diagnosticErrorCode(error: unknown): 'UNKNOWN' | 'TIMEOUT' | 'CANCELLED' | 'RESPONSE_INVALID' | 'RESPONSE_TOO_LARGE' | 'NETWORK_ERROR'
  | 'ACCOUNT_BINDING_CHANGED' | 'ACCOUNT_DISCONNECTED' | 'WORKER_UNAVAILABLE' {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const reason = error && typeof error === 'object' ? (error as { diagnostic?: { reason?: string } }).diagnostic?.reason : undefined;
  return reason === 'stale_binding' || message.includes('binding changed') ? 'ACCOUNT_BINDING_CHANGED' : reason === 'missing_worker' ? 'WORKER_UNAVAILABLE'
    : reason === 'not_ready_worker' ? 'ACCOUNT_DISCONNECTED' : message.includes('timeout') ? 'TIMEOUT' : message.includes('cancel') || message.includes('abort') ? 'CANCELLED'
      : message.includes('large') || message.includes('oversized') ? 'RESPONSE_TOO_LARGE'
        : message.includes('invalid') ? 'RESPONSE_INVALID' : message.includes('network') ? 'NETWORK_ERROR' : 'UNKNOWN';
}

function noteMarkdown(note: NoteDto): Uint8Array {
  const created = note.createdTime === null || note.createdTime > 8_640_000_000_000_000 ? 'Unknown' : new Date(note.createdTime).toISOString();
  const content = note.content === undefined ? '' : JSON.stringify(note.content, null, 2);
  const body = `${GENERATED_NOTE_MARKER}\n<!-- postId:${safeId(note.postId)} -->\n# Note ${safeId(note.postId)}\n\nCreated: ${created}\n\n## Text\n\n${fenced(note.text ?? '', 'text')}\n\n## Content\n\n${fenced(content, 'json')}\n`;
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.byteLength > MAX_NOTE_TEXT * 2) throw new Error('Chat resource archive record exceeds its size limit.');
  return bytes;
}
