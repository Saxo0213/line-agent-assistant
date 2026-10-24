import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationKey } from '@line-agent/contracts';
import { chatLayerDirectory, type ChatFolderService } from './chat-folders.js';
import { isReadableAlbumFolderName, isReadableAlbumPhotoName } from './album-readable-view.js';

const PROTOCOL = 'chat-resource-archive/v1';
const QUEUE_LIMIT = 16;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_RESOURCE_ID_BYTES = 96;

export type ChatResourceKind = 'note' | 'album' | 'photo-page' | 'photo' | 'album-photo';
export interface ChatResourceIdentity { readonly volumeSerial: string; readonly fileId: string; }
export interface BoundChatResourceFolder {
  readonly segments: readonly string[];
  readonly identity: ChatResourceIdentity;
}
export interface ChatResourceArchiveOptions {
  readonly workspaceRoot: string;
  readonly helperPath?: string;
  readonly idleStopMs?: number;
  readonly operationTimeoutMs?: number;
  /** Test fixture only: pauses the native host at named operation boundaries. */
  readonly testPauseBoundaryFile?: string;
}
function electronAppIsPackaged(): boolean {
  if (!process.versions.electron) return false;
  try { return require('electron').app.isPackaged === true; }
  catch { throw new ChatResourceArchiveError('PACKAGING_STATE_UNAVAILABLE'); }
}
export function resolveChatResourceArchiveHelperPath(input: { readonly isPackaged: boolean; readonly resourcesPath?: string; readonly moduleUrl?: string }): string {
  if (input.isPackaged) {
    if (!input.resourcesPath || !isAbsolute(input.resourcesPath)) throw new ChatResourceArchiveError('INVALID_RESOURCES_PATH');
    return join(input.resourcesPath, 'native', 'ChatResourceArchiveHost.exe');
  }
  return fileURLToPath(new URL('./native/ChatResourceArchiveHost.exe', input.moduleUrl ?? import.meta.url));
}
export function isCanonicalChatResourceTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export interface ChatResourceStoreAdapter {
  publish(input: { key: ConversationKey; kind: ChatResourceKind; resourceId: string; content: Uint8Array; signal: AbortSignal; guard: () => void }): Promise<ChatResourceMetadata>;
  ensureAlbumFolder(input: { key: ConversationKey; albumId: string; signal: AbortSignal; guard: () => void }): Promise<void>;
  inspectAlbumPhoto(input: { key: ConversationKey; albumId: string; photoId: string; signal: AbortSignal; guard: () => void }): Promise<ChatResourceAlbumPhotoFile | null>;
  readAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; signal: AbortSignal; guard: () => void }): Promise<(ChatResourceAlbumPhotoFile & { content: Uint8Array }) | null>;
  hasAlbumPhoto(input: { key: ConversationKey; albumId: string; photoId: string; signal: AbortSignal; guard: () => void }): Promise<boolean>;
  publishAlbumPhoto(input: { key: ConversationKey; albumId: string; photoId: string; content: Uint8Array; signal: AbortSignal; guard: () => void }): Promise<ChatResourceAlbumPhotoFile>;
  materializeAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; canonicalFile: ChatResourceAlbumPhotoFile; viewFolderName: string; viewFileName: string; signal: AbortSignal; guard: () => void }): Promise<{ unchanged: boolean }>;
  ensureReadableAlbumFolder?(input: { key: ConversationKey; viewFolderName: string; signal: AbortSignal; guard: () => void }): Promise<void>;
  materializeAlbumPhoto?(input: { key: ConversationKey; albumId: string; photoId: string; canonicalFile: ChatResourceAlbumPhotoFile;
    viewFolderName: string; viewFileName: string; signal: AbortSignal; guard: () => void }): Promise<{ unchanged: boolean }>;
  read(input: { key: ConversationKey; kind: ChatResourceKind; resourceId: string; signal?: AbortSignal }): Promise<(ChatResourceMetadata & { content: Uint8Array }) | null>;
  list(input: { key: ConversationKey; kind: ChatResourceKind; limit: number; cursor?: string | null; signal?: AbortSignal }): Promise<{ items: ChatResourceMetadata[]; nextCursor: string | null }>;
  close(): Promise<void>;
  forceClose(): void;
}
export interface ChatResourceMetadata {
  readonly resourceId: string;
  readonly revision: number;
  readonly savedAt: string;
  readonly contentHash: string;
  readonly byteLength: number;
}
export type ChatResourceAlbumPhotoFile = Readonly<{ folderName: string; fileName: string; revision: number; savedAt: string; contentHash: string; byteCount: number }>;
export class ChatResourceArchiveError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Chat resource archive failed (${code})`); this.name = 'ChatResourceArchiveError'; this.code = code; }
}

function assertResourceId(resourceId: unknown): asserts resourceId is string {
  if (typeof resourceId !== 'string' || resourceId.length === 0 || Buffer.byteLength(resourceId, 'utf8') > MAX_RESOURCE_ID_BYTES
    || Buffer.from(resourceId, 'utf8').toString('utf8') !== resourceId) throw new ChatResourceArchiveError('INVALID_RESOURCE_ID');
}

interface RequestBase { readonly protocol: typeof PROTOCOL; readonly requestId: string; readonly op: string; readonly chatSegments: readonly string[]; readonly volumeSerial: string; readonly fileId: string; readonly kind: ChatResourceKind; }
interface ArchiveRequest extends RequestBase { readonly resourceId?: string; readonly albumKey?: string; readonly limit?: number; readonly cursor?: string; readonly stageId?: string;
  readonly canonicalFileName?: string; readonly viewFolderName?: string; readonly viewFileName?: string; readonly expectedHash?: string; }
interface NativeResult {
  readonly protocol: typeof PROTOCOL;
  readonly requestId: string;
  readonly ok: boolean;
  readonly unchanged?: boolean;
  readonly code?: string;
  readonly revision?: number;
  readonly savedAt?: string;
  readonly contentHash?: string;
  readonly byteLength?: number;
  readonly items?: readonly ChatResourceMetadata[];
  readonly nextCursor?: string;
  readonly payloadLength?: number;
  readonly stageId?: string;
  readonly folderName?: string;
  readonly fileName?: string;
}
interface Job { readonly request: ArchiveRequest; readonly payload?: Uint8Array; readonly signal?: AbortSignal; readonly guard?: () => void; readonly timeoutMs: number; readonly resolve: (value: { result: NativeResult; payload: Buffer }) => void; readonly reject: (error: unknown) => void; readonly onAbort: () => void; timer?: ReturnType<typeof setTimeout>; settled: boolean; }

function frame(data: Uint8Array): Buffer { const length = Buffer.allocUnsafe(4); length.writeUInt32LE(data.byteLength); return Buffer.concat([length, Buffer.from(data)]); }
function frameLength(length: number): Buffer { const value = Buffer.allocUnsafe(4); value.writeUInt32LE(length); return value; }
function safeSegment(value: string): boolean { return value.length > 0 && value !== '.' && value !== '..' && !/[\\/:\0]/.test(value) && !/[. ]$/.test(value); }

class FrameReader {
  #buffer = Buffer.alloc(0);
  #waiters: Array<{ max: number; resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];
  #closed: Error | undefined;
  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer) => { this.#buffer = Buffer.concat([this.#buffer, chunk]); this.#flush(); });
    stream.on('error', (error) => this.fail(error instanceof Error ? error : new Error('host output failed')));
    stream.on('end', () => this.fail(new Error('host closed its output')));
  }
  read(max: number): Promise<Buffer> {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolveRead, rejectRead) => { this.#waiters.push({ max, resolve: resolveRead, reject: rejectRead }); this.#flush(); });
  }
  fail(error: Error): void { if (this.#closed) return; this.#closed = error; for (const waiter of this.#waiters.splice(0)) waiter.reject(error); }
  #flush(): void {
    while (this.#waiters.length > 0 && this.#buffer.byteLength >= 4) {
      const waiter = this.#waiters[0]!; const length = this.#buffer.readUInt32LE(0);
      if (length > waiter.max) { this.#waiters.shift()!.reject(new Error('host frame exceeded its limit')); this.fail(new Error('host frame exceeded its limit')); return; }
      if (this.#buffer.byteLength < length + 4) return;
      this.#waiters.shift(); const value = this.#buffer.subarray(4, length + 4); this.#buffer = this.#buffer.subarray(length + 4); waiter.resolve(value);
    }
  }
}

let activeArchive: ChatResourceArchive | undefined;

/** Main-owned single-process adapter for generated note and album files. */
export class ChatResourceArchive {
  readonly #workspaceRoot: string;
  readonly #helperPath: string;
  readonly #idleStopMs: number;
  readonly #operationTimeoutMs: number;
  readonly #testPauseBoundaryFile: string | undefined;
  readonly #queue: Job[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #stoppingChild: ChildProcessWithoutNullStreams | undefined;
  #startupPromise: Promise<{ child: ChildProcessWithoutNullStreams; reader: FrameReader }> | undefined;
  #reader: FrameReader | undefined;
  #active: Job | undefined;
  #pumpRunning = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: ChatResourceArchiveOptions) {
    if (process.platform !== 'win32') throw new ChatResourceArchiveError('UNSUPPORTED_PLATFORM');
    if (activeArchive && !activeArchive.#closed) throw new ChatResourceArchiveError('HOST_ALREADY_OWNED');
    if (!isAbsolute(options.workspaceRoot)) throw new ChatResourceArchiveError('INVALID_WORKSPACE_ROOT');
    this.#workspaceRoot = resolve(options.workspaceRoot);
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    this.#helperPath = options.helperPath ?? resolveChatResourceArchiveHelperPath({ isPackaged: electronAppIsPackaged(), ...(resourcesPath ? { resourcesPath } : {}) });
    this.#idleStopMs = options.idleStopMs ?? 30_000;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    this.#testPauseBoundaryFile = options.testPauseBoundaryFile;
    if (!Number.isSafeInteger(this.#idleStopMs) || this.#idleStopMs < 1 || !Number.isSafeInteger(this.#operationTimeoutMs) || this.#operationTimeoutMs < 100) throw new ChatResourceArchiveError('INVALID_LIMIT');
    activeArchive = this;
  }

  get inventory(): Readonly<{ hostProcesses: number; active: boolean; queued: number; queueLimit: number }> {
    return { hostProcesses: this.#child && this.#child.exitCode === null ? 1 : 0, active: this.#active !== undefined, queued: this.#queue.length, queueLimit: QUEUE_LIMIT };
  }

  async bindChat(input: { readonly canonicalPath: string; readonly segments: readonly string[] }): Promise<BoundChatResourceFolder> {
    if (this.#closed) throw new ChatResourceArchiveError('CLOSED');
    if (input.segments.length < 2 || input.segments.length > 8 || !input.segments.every(safeSegment)) throw new ChatResourceArchiveError('INVALID_CHAT');
    const root = await realpath(this.#workspaceRoot);
    const canonical = await realpath(input.canonicalPath);
    const expected = resolve(root, ...input.segments);
    const rel = relative(root, canonical);
    if (canonical !== expected || rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).length !== input.segments.length) throw new ChatResourceArchiveError('CHAT_PATH_MISMATCH');
    const identity = await stat(canonical, { bigint: true });
    return Object.freeze({ segments: Object.freeze([...input.segments]), identity: Object.freeze({ volumeSerial: identity.dev.toString(10), fileId: identity.ino.toString(16).padStart(16, '0') }) });
  }

  async publish(input: { readonly chat: BoundChatResourceFolder; readonly kind: ChatResourceKind; readonly resourceId: string; readonly content: Uint8Array; readonly signal?: AbortSignal; readonly guard?: () => void }): Promise<ChatResourceMetadata> {
    assertResourceId(input.resourceId);
    if (!(input.content instanceof Uint8Array) || input.content.byteLength > MAX_CONTENT_BYTES) throw new ChatResourceArchiveError('PAYLOAD_LIMIT');
    const result = await this.#submit(input.chat, input.kind, 'publish', { resourceId: input.resourceId }, input.content, input.signal, input.guard);
    this.#assertMetadata(result);
    const hash = createHash('sha256').update(input.content).digest('hex');
    if (result.contentHash !== hash || result.byteLength !== input.content.byteLength) throw new ChatResourceArchiveError('CONTENT_MISMATCH');
    return this.#metadata(input.resourceId, result);
  }

  async ensureAlbumFolder(input: { readonly chat: BoundChatResourceFolder; readonly albumId: string; readonly signal?: AbortSignal; readonly guard?: () => void }): Promise<void> {
    const albumKey = createHash('sha256').update(input.albumId, 'utf8').digest('hex');
    const { result } = await this.#submitRaw(input.chat, 'album-photo', 'album-open', { albumKey }, undefined, input.signal, input.guard);
    if (!result.ok) throw new ChatResourceArchiveError('NATIVE_FAILURE');
  }

  async ensureReadableAlbumFolder(input: { readonly chat: BoundChatResourceFolder; readonly viewFolderName: string; readonly signal?: AbortSignal; readonly guard?: () => void }): Promise<void> {
    if (!isReadableAlbumFolderName(input.viewFolderName)) throw new ChatResourceArchiveError('INVALID_READABLE_EXPORT');
    const { result } = await this.#submitRaw(input.chat, 'album', 'readable-folder-open', { viewFolderName: input.viewFolderName }, undefined, input.signal, input.guard);
    if (!result.ok) throw new ChatResourceArchiveError('NATIVE_FAILURE');
  }

  async publishAlbumPhoto(input: { readonly chat: BoundChatResourceFolder; readonly albumId: string; readonly photoId: string; readonly content: Uint8Array;
    readonly signal?: AbortSignal; readonly guard?: () => void }): Promise<ChatResourceAlbumPhotoFile> {
    const resourceId = createHash('sha256').update(input.photoId, 'utf8').digest('hex');
    if (!(input.content instanceof Uint8Array) || input.content.byteLength < 1 || input.content.byteLength > MAX_CONTENT_BYTES) throw new ChatResourceArchiveError('PAYLOAD_LIMIT');
    const albumKey = createHash('sha256').update(input.albumId, 'utf8').digest('hex');
    const result = await this.#submit(input.chat, 'album-photo', 'publish', { albumKey, resourceId }, input.content, input.signal, input.guard);
    this.#assertMetadata(result);
    const hash = createHash('sha256').update(input.content).digest('hex');
    if (result.contentHash !== hash || result.byteLength !== input.content.byteLength) throw new ChatResourceArchiveError('CONTENT_MISMATCH');
    return this.#albumPhotoFile(input.albumId, input.photoId, result);
  }

  async inspectAlbumPhoto(input: { readonly chat: BoundChatResourceFolder; readonly albumId: string; readonly photoId: string; readonly signal?: AbortSignal;
    readonly guard?: () => void }): Promise<ChatResourceAlbumPhotoFile | null> {
    const albumKey = createHash('sha256').update(input.albumId, 'utf8').digest('hex');
    const resourceId = createHash('sha256').update(input.photoId, 'utf8').digest('hex');
    const result = await this.#submit(input.chat, 'album-photo', 'contains', { albumKey, resourceId }, undefined, input.signal, input.guard);
    if ((result.revision ?? 0) === 0) return null;
    return this.#albumPhotoFile(input.albumId, input.photoId, result);
  }

  async readAlbumPhoto(input: { readonly chat: BoundChatResourceFolder; readonly albumId: string; readonly photoId: string; readonly signal?: AbortSignal;
    readonly guard?: () => void }): Promise<(ChatResourceAlbumPhotoFile & { content: Buffer }) | null> {
    const albumKey = createHash('sha256').update(input.albumId, 'utf8').digest('hex');
    const resourceId = createHash('sha256').update(input.photoId, 'utf8').digest('hex');
    const { result, payload } = await this.#submitRaw(input.chat, 'album-photo', 'read', { albumKey, resourceId }, undefined, input.signal, input.guard);
    if ((result.revision ?? 0) === 0) return null;
    const file = this.#albumPhotoFile(input.albumId, input.photoId, result);
    if (payload.byteLength !== file.byteCount || createHash('sha256').update(payload).digest('hex') !== file.contentHash) throw new ChatResourceArchiveError('CONTENT_MISMATCH');
    return { ...file, content: payload };
  }

  async materializeAlbumPhoto(input: { readonly chat: BoundChatResourceFolder; readonly albumId: string; readonly photoId: string;
    readonly canonicalFile: ChatResourceAlbumPhotoFile; readonly viewFolderName: string; readonly viewFileName: string;
    readonly signal?: AbortSignal; readonly guard?: () => void }): Promise<{ unchanged: boolean }> {
    if (!input.canonicalFile || !/^[0-9a-f]{64}$/.test(input.canonicalFile.contentHash) || !Number.isSafeInteger(input.canonicalFile.byteCount)
      || input.canonicalFile.byteCount < 1 || input.canonicalFile.byteCount > 20 * 1024 * 1024
      || input.canonicalFile.folderName !== createHash('sha256').update(input.albumId, 'utf8').digest('hex')
      || !/^record_f_[A-Za-z0-9_-]+_[0-9]{20}_[0-9]{8}T[0-9]{9}Z_[0-9a-f]{64}\.(jpg|png|webp|gif)$/.test(input.canonicalFile.fileName)
      || !isReadableAlbumFolderName(input.viewFolderName) || !isReadableAlbumPhotoName(input.viewFileName)) {
      throw new ChatResourceArchiveError('INVALID_READABLE_EXPORT');
    }
    const albumKey = createHash('sha256').update(input.albumId, 'utf8').digest('hex');
    const resourceId = createHash('sha256').update(input.photoId, 'utf8').digest('hex');
    const result = await this.#submitRaw(input.chat, 'album-photo', 'readable-export', { albumKey, resourceId,
      canonicalFileName: input.canonicalFile.fileName, viewFolderName: input.viewFolderName, viewFileName: input.viewFileName,
      expectedHash: input.canonicalFile.contentHash }, undefined, input.signal, input.guard);
    if (result.payload.byteLength !== 0) throw new ChatResourceArchiveError('MALFORMED_RESULT');
    return { unchanged: result.result.unchanged === true };
  }

  async hasAlbumPhoto(input: { readonly chat: BoundChatResourceFolder; readonly albumId: string; readonly photoId: string; readonly signal?: AbortSignal;
    readonly guard?: () => void }): Promise<boolean> {
    return (await this.inspectAlbumPhoto(input)) !== null;
  }

  #albumPhotoFile(albumId: string, photoId: string, result: NativeResult): ChatResourceAlbumPhotoFile {
    this.#assertMetadata(result);
    const folderName = createHash('sha256').update(albumId, 'utf8').digest('hex');
    const resourceId = createHash('sha256').update(photoId, 'utf8').digest('hex');
    const encodedResourceId = Buffer.from(resourceId, 'utf8').toString('base64url');
    const fileName = result.fileName;
    const expectedPrefix = `record_f_${encodedResourceId}_`;
    if (result.folderName !== folderName || typeof fileName !== 'string' || fileName.length > 240
      || fileName.includes('/') || fileName.includes('\\') || fileName.includes(':') || !fileName.startsWith(expectedPrefix)
      || !/^record_f_[A-Za-z0-9_-]+_[0-9]{20}_[0-9]{8}T[0-9]{9}Z_[0-9a-f]{64}\.(jpg|png|webp|gif)$/.test(fileName)) {
      throw new ChatResourceArchiveError('MALFORMED_RESULT');
    }
    return { folderName, fileName, revision: result.revision!, savedAt: result.savedAt!, contentHash: result.contentHash!, byteCount: result.byteLength! };
  }

  async read(input: { readonly chat: BoundChatResourceFolder; readonly kind: ChatResourceKind; readonly resourceId: string; readonly signal?: AbortSignal }): Promise<(ChatResourceMetadata & { readonly content: Buffer }) | null> {
    assertResourceId(input.resourceId);
    const { result, payload } = await this.#submitRaw(input.chat, input.kind, 'read', { resourceId: input.resourceId }, undefined, input.signal);
    if (result.revision === 0) return null;
    this.#assertMetadata(result);
    if (result.byteLength !== payload.byteLength || createHash('sha256').update(payload).digest('hex') !== result.contentHash) throw new ChatResourceArchiveError('CONTENT_MISMATCH');
    return { ...this.#metadata(input.resourceId, result), content: payload };
  }

  async list(input: { readonly chat: BoundChatResourceFolder; readonly kind: ChatResourceKind; readonly limit: number; readonly cursor?: string; readonly signal?: AbortSignal }): Promise<{ readonly items: readonly ChatResourceMetadata[]; readonly nextCursor: string | null }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new ChatResourceArchiveError('INVALID_LIMIT');
    if (input.cursor !== undefined && input.cursor.length > 1024) throw new ChatResourceArchiveError('INVALID_CURSOR');
    const { result } = await this.#submitRaw(input.chat, input.kind, 'list', { limit: input.limit, cursor: input.cursor ?? '' }, undefined, input.signal);
    if (!Array.isArray(result.items) || result.items.length > input.limit || result.items.some((item) => !this.#validMetadata(item))) throw new ChatResourceArchiveError('MALFORMED_RESULT');
    return { items: result.items, nextCursor: result.nextCursor || null };
  }


  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; if (this.#idleTimer) clearTimeout(this.#idleTimer); this.#idleTimer = undefined;
    for (const job of this.#queue.splice(0)) this.#settle(job, new ChatResourceArchiveError('CLOSED'));
    if (this.#active) this.#settle(this.#active, new ChatResourceArchiveError('CLOSED'));
    await this.#awaitStartup();
    await this.#stopHost(); if (activeArchive === this) activeArchive = undefined;
  }

  /** Synchronous owner-termination fallback for bounded application shutdown. */
  forceClose(): void {
    this.#closed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer); this.#idleTimer = undefined;
    for (const job of this.#queue.splice(0)) this.#settle(job, new ChatResourceArchiveError('CLOSED'));
    if (this.#active) this.#settle(this.#active, new ChatResourceArchiveError('CLOSED'));
    const reader = this.#reader; this.#reader = undefined; reader?.fail(new Error('host force-closed'));
    const child = this.#child; this.#child = undefined;
    try { child?.kill(); } catch { /* Best-effort termination fallback. */ }
    try { this.#stoppingChild?.kill(); } catch { /* Best-effort termination fallback. */ }
    if (activeArchive === this) activeArchive = undefined;
  }

  #validMetadata(value: ChatResourceMetadata): boolean {
    return !!value && typeof value.resourceId === 'string' && value.resourceId.length > 0 && Buffer.byteLength(value.resourceId, 'utf8') <= MAX_RESOURCE_ID_BYTES
      && Buffer.from(value.resourceId, 'utf8').toString('utf8') === value.resourceId && Number.isSafeInteger(value.revision) && value.revision > 0
      && isCanonicalChatResourceTimestamp(value.savedAt) && /^[0-9a-f]{64}$/.test(value.contentHash) && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 && value.byteLength <= MAX_CONTENT_BYTES;
  }
  #assertMetadata(result: NativeResult): void { if (!this.#validMetadata({ resourceId: 'resource', revision: result.revision!, savedAt: result.savedAt!, contentHash: result.contentHash!, byteLength: result.byteLength! })) throw new ChatResourceArchiveError('MALFORMED_RESULT'); }
  #metadata(resourceId: string, result: NativeResult): ChatResourceMetadata { return { resourceId, revision: result.revision!, savedAt: result.savedAt!, contentHash: result.contentHash!, byteLength: result.byteLength! }; }

  #submit(chat: BoundChatResourceFolder, kind: ChatResourceKind, op: string, extra: object, payload?: Uint8Array, signal?: AbortSignal, guard?: () => void): Promise<NativeResult> {
    return this.#submitRaw(chat, kind, op, extra, payload, signal, guard).then((value) => value.result);
  }
  #submitRaw(chat: BoundChatResourceFolder, kind: ChatResourceKind, op: string, extra: object, payload?: Uint8Array, signal?: AbortSignal, guard?: () => void): Promise<{ result: NativeResult; payload: Buffer }> {
    if (this.#closed) return Promise.reject(new ChatResourceArchiveError('CLOSED'));
    if (signal?.aborted) return Promise.reject(new ChatResourceArchiveError('ABORTED'));
    if (this.#queue.length >= QUEUE_LIMIT) return Promise.reject(new ChatResourceArchiveError('QUEUE_FULL'));
    if (!chat || !Array.isArray(chat.segments) || !chat.segments.every(safeSegment) || !/^[0-9]+$/.test(chat.identity.volumeSerial) || !/^[0-9a-f]{16}$/.test(chat.identity.fileId)) return Promise.reject(new ChatResourceArchiveError('INVALID_CHAT'));
    if (!['note', 'album', 'photo-page', 'photo', 'album-photo'].includes(kind)) return Promise.reject(new ChatResourceArchiveError('INVALID_KIND'));
    let job!: Job;
    const promise = new Promise<{ result: NativeResult; payload: Buffer }>((resolveJob, rejectJob) => {
      job = { request: { protocol: PROTOCOL, requestId: randomUUID(), op: op === 'publish' ? 'stage' : op, chatSegments: chat.segments, volumeSerial: chat.identity.volumeSerial, fileId: chat.identity.fileId, kind, ...extra },
        ...(payload ? { payload } : {}), ...(signal ? { signal } : {}), ...(guard ? { guard } : {}), timeoutMs: this.#operationTimeoutMs, resolve: resolveJob, reject: rejectJob, onAbort: () => this.#abort(job), settled: false };
    });
    signal?.addEventListener('abort', job.onAbort, { once: true });
    this.#queue.push(job); if (this.#idleTimer) clearTimeout(this.#idleTimer); this.#idleTimer = undefined;
    void this.#pump(); return promise;
  }

  async #pump(): Promise<void> {
    if (this.#pumpRunning || this.#closed) return;
    this.#pumpRunning = true;
    try {
      while (!this.#closed && this.#queue.length > 0) {
        const job = this.#queue.shift()!;
        if (job.settled) continue;
        this.#active = job;
        try {
          job.timer = setTimeout(() => { this.#settle(job, new ChatResourceArchiveError('TIMEOUT')); void this.#stopHost(); }, job.timeoutMs); job.timer.unref();
          const value = await this.#exchange(job); this.#settle(job, undefined, value);
        } catch (error) {
          await this.#stopHost(); this.#settle(job, error instanceof ChatResourceArchiveError ? error : new ChatResourceArchiveError('HOST_FAILURE'));
        } finally { if (job.timer) clearTimeout(job.timer); this.#active = undefined; }
      }
    } finally {
      this.#pumpRunning = false;
      if (!this.#closed && this.#queue.length === 0 && this.#child) {
        this.#idleTimer = setTimeout(() => { this.#idleTimer = undefined; if (!this.#active && this.#queue.length === 0) void this.#stopHost(); }, this.#idleStopMs); this.#idleTimer.unref();
      }
      if (!this.#closed && this.#queue.length > 0) void this.#pump();
    }
  }

  async #ensureHost(job: Job): Promise<{ child: ChildProcessWithoutNullStreams; reader: FrameReader }> {
    if (this.#child && this.#reader && this.#child.exitCode === null) return { child: this.#child, reader: this.#reader };
    const startup = (async () => {
      const root = await realpath(this.#workspaceRoot); this.#assertCanStart(job);
      const helper = await realpath(this.#helperPath); this.#assertCanStart(job);
      const normalizedHelper = helper.toLowerCase();
      if (!isAbsolute(helper) || (!normalizedHelper.endsWith('chatresourcearchivehost.exe') && !normalizedHelper.endsWith('chatresourcearchivehost.test.exe'))) throw new ChatResourceArchiveError('INVALID_HELPER');
      const child = spawn(helper, ['--stdio-v1', root], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ...(this.#testPauseBoundaryFile ? { CHAT_RESOURCE_ARCHIVE_TEST_PAUSE_FILE: this.#testPauseBoundaryFile } : {}) } });
      const reader = new FrameReader(child.stdout); child.stderr.resume();
      child.once('close', () => { if (this.#child === child) { this.#child = undefined; this.#reader = undefined; } });
      child.once('error', () => reader.fail(new Error('host process failed to start')));
      this.#child = child; this.#reader = reader; return { child, reader };
    })();
    this.#startupPromise = startup;
    try { return await startup; } finally { if (this.#startupPromise === startup) this.#startupPromise = undefined; }
  }

  #assertCanStart(job: Job): void {
    if (this.#closed || job.settled) throw new ChatResourceArchiveError('CLOSED');
    if (job.signal?.aborted) throw new ChatResourceArchiveError('ABORTED');
  }

  async #awaitStartup(): Promise<void> {
    const startup = this.#startupPromise; if (!startup) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([startup.then(() => undefined, () => undefined), new Promise<void>((resolveWait) => { timer = setTimeout(resolveWait, 250); timer.unref(); })]);
    if (timer) clearTimeout(timer);
  }

  async #exchange(job: Job): Promise<{ result: NativeResult; payload: Buffer }> {
    if (job.signal?.aborted) throw new ChatResourceArchiveError('ABORTED');
    const { child, reader } = await this.#ensureHost(job);
    this.#assertCanStart(job);
    if (job.request.op !== 'stage') job.guard?.();
    const header = Buffer.from(JSON.stringify(job.request), 'utf8'); if (header.byteLength > MAX_CONTROL_BYTES) throw new ChatResourceArchiveError('CONTROL_LIMIT');
    await this.#write(child, frame(header));
    if (job.payload) {
      for (let offset = 0; offset < job.payload.byteLength; offset += CHUNK_BYTES) {
        const chunk = job.payload.subarray(offset, Math.min(offset + CHUNK_BYTES, job.payload.byteLength)); await this.#write(child, frame(chunk));
      }
      await this.#write(child, frameLength(0));
    }
    let { result, payload: payloadFrame } = await this.#readResponse(reader, job.request.requestId);
    this.#assertCanStart(job); job.guard?.();
    if (!result.ok) throw new ChatResourceArchiveError(typeof result.code === 'string' && /^[A-Z0-9_]{2,48}$/.test(result.code) ? result.code : 'NATIVE_FAILURE');
    if (job.request.op === 'stage') {
      if (result.unchanged === true) {
        if (result.stageId || payloadFrame.byteLength !== 0) throw new ChatResourceArchiveError('MALFORMED_RESULT');
        if (job.signal?.aborted) throw new ChatResourceArchiveError('ABORTED');
        job.guard?.();
        if (job.signal?.aborted) throw new ChatResourceArchiveError('ABORTED');
        return { result, payload: Buffer.alloc(0) };
      }
      if (!result.stageId || !/^[0-9a-f]{32}$/.test(result.stageId) || payloadFrame.byteLength !== 0) throw new ChatResourceArchiveError('MALFORMED_RESULT');
      if (job.signal?.aborted) throw new ChatResourceArchiveError('ABORTED');
      job.guard?.();
      if (job.signal?.aborted) throw new ChatResourceArchiveError('ABORTED');
      const commit: ArchiveRequest = { ...job.request, requestId: randomUUID(), op: 'commit', stageId: result.stageId };
      const commitHeader = Buffer.from(JSON.stringify(commit), 'utf8'); await this.#write(child, frame(commitHeader));
      ({ result, payload: payloadFrame } = await this.#readResponse(reader, commit.requestId));
      this.#assertCanStart(job); job.guard?.();
      if (!result.ok) throw new ChatResourceArchiveError(typeof result.code === 'string' && /^[A-Z0-9_]{2,48}$/.test(result.code) ? result.code : 'NATIVE_FAILURE');
    }
    if (result.payloadLength !== undefined && result.payloadLength !== payloadFrame.byteLength) throw new ChatResourceArchiveError('MALFORMED_RESULT');
    return { result, payload: payloadFrame };
  }

  async #readResponse(reader: FrameReader, requestId: string): Promise<{ result: NativeResult; payload: Buffer }> {
    const resultFrame = await reader.read(MAX_CONTROL_BYTES); let value: unknown;
    try { value = JSON.parse(resultFrame.toString('utf8')); } catch { throw new ChatResourceArchiveError('MALFORMED_RESULT'); }
    if (!value || typeof value !== 'object') throw new ChatResourceArchiveError('MALFORMED_RESULT');
    const result = value as NativeResult;
    if (result.protocol !== PROTOCOL || result.requestId !== requestId || typeof result.ok !== 'boolean') throw new ChatResourceArchiveError('PROTOCOL_MISMATCH');
    const payload = await reader.read(MAX_CONTENT_BYTES);
    if (result.payloadLength !== undefined && result.payloadLength !== payload.byteLength) throw new ChatResourceArchiveError('MALFORMED_RESULT');
    return { result, payload };
  }

  async #write(child: ChildProcessWithoutNullStreams, data: Uint8Array): Promise<void> {
    if (child.stdin.destroyed) throw new ChatResourceArchiveError('BROKEN_PIPE');
    await new Promise<void>((resolveWrite, rejectWrite) => child.stdin.write(data, (error) => error ? rejectWrite(new ChatResourceArchiveError('BROKEN_PIPE')) : resolveWrite()));
  }
  #settle(job: Job, error?: unknown, value?: { result: NativeResult; payload: Buffer }): void {
    if (job.settled) return; job.settled = true; if (job.timer) clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error); else job.resolve(value!);
  }
  #abort(job: Job): void {
    if (job.settled) return;
    const index = this.#queue.indexOf(job);
    if (index >= 0) { this.#queue.splice(index, 1); this.#settle(job, new ChatResourceArchiveError('ABORTED')); return; }
    if (this.#active === job) { this.#settle(job, new ChatResourceArchiveError('ABORTED')); void this.#stopHost(); }
  }
  async #stopHost(): Promise<void> {
    const child = this.#child; const reader = this.#reader; this.#child = undefined; this.#reader = undefined; reader?.fail(new Error('host stopped'));
    if (!child || child.exitCode !== null) return;
    this.#stoppingChild = child;
    await new Promise<void>((resolveStop) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); if (this.#stoppingChild === child) this.#stoppingChild = undefined; resolveStop(); };
      const timer = setTimeout(() => { child.kill(); finish(); }, 1_000); timer.unref();
      child.once('close', finish);
      child.kill();
    });
  }
}

/** Adapts ConversationKey requests to canonical folders; paths remain Main-local. */
export function createChatResourceStoreAdapter(input: {
  readonly archive: ChatResourceArchive;
  readonly folders: ChatFolderService;
  readonly createdBy?: string;
}): ChatResourceStoreAdapter {
  const bind = async (key: ConversationKey, create: boolean): Promise<BoundChatResourceFolder | null> => {
    const resolved = create
      ? await input.folders.resolve(key.accountId, key.chatType, key.chatId, input.createdBy ?? 'chat-resource-archive')
      : await input.folders.resolveExisting(key.accountId, key.chatType, key.chatId);
    if (!resolved) return null;
    const segments = [chatLayerDirectory(key.chatType), resolved.folder.folderId];
    return input.archive.bindChat({ canonicalPath: resolved.path, segments });
  };
  return {
    async publish(value) {
      const chat = await bind(value.key, true);
      if (!chat) throw new ChatResourceArchiveError('CHAT_FOLDER_UNAVAILABLE');
      return input.archive.publish({ chat, kind: value.kind, resourceId: value.resourceId, content: value.content, signal: value.signal, guard: value.guard });
    },
    async read(value) {
      const chat = await bind(value.key, false);
      if (!chat) return null;
      const result = await input.archive.read({ chat, kind: value.kind, resourceId: value.resourceId, ...(value.signal ? { signal: value.signal } : {}) });
      return result && { ...result, content: new Uint8Array(result.content) };
    },
    async list(value) {
      const chat = await bind(value.key, false);
      if (!chat) return { items: [], nextCursor: null };
      const page = await input.archive.list({ chat, kind: value.kind, limit: value.limit, ...(value.cursor ? { cursor: value.cursor } : {}), ...(value.signal ? { signal: value.signal } : {}) });
      return { items: [...page.items], nextCursor: page.nextCursor };
    },
    async ensureAlbumFolder(value) {
      const chat = await bind(value.key, true);
      if (!chat) throw new ChatResourceArchiveError('CHAT_FOLDER_UNAVAILABLE');
      await input.archive.ensureAlbumFolder({ chat, albumId: value.albumId, signal: value.signal, guard: value.guard });
    },
    async ensureReadableAlbumFolder(value) {
      const chat = await bind(value.key, true);
      if (!chat) throw new ChatResourceArchiveError('CHAT_FOLDER_UNAVAILABLE');
      await input.archive.ensureReadableAlbumFolder({ chat, viewFolderName: value.viewFolderName, signal: value.signal, guard: value.guard });
    },
    async publishAlbumPhoto(value) {
      const chat = await bind(value.key, true);
      if (!chat) throw new ChatResourceArchiveError('CHAT_FOLDER_UNAVAILABLE');
      return input.archive.publishAlbumPhoto({ chat, albumId: value.albumId, photoId: value.photoId, content: value.content,
        signal: value.signal, guard: value.guard });
    },
    async inspectAlbumPhoto(value) {
      const chat = await bind(value.key, false);
      if (!chat) return null;
      return input.archive.inspectAlbumPhoto({ chat, albumId: value.albumId, photoId: value.photoId, signal: value.signal, guard: value.guard });
    },
    async readAlbumPhoto(value) {
      const chat = await bind(value.key, false);
      if (!chat) return null;
      return input.archive.readAlbumPhoto({ chat, albumId: value.albumId, photoId: value.photoId, signal: value.signal, guard: value.guard });
    },
    async materializeAlbumPhoto(value) {
      const chat = await bind(value.key, false);
      if (!chat) throw new ChatResourceArchiveError('CHAT_FOLDER_UNAVAILABLE');
      return input.archive.materializeAlbumPhoto({ chat, albumId: value.albumId, photoId: value.photoId, canonicalFile: value.canonicalFile,
        viewFolderName: value.viewFolderName, viewFileName: value.viewFileName, signal: value.signal, guard: value.guard });
    },
    async hasAlbumPhoto(value) {
      const chat = await bind(value.key, false);
      if (!chat) return false;
      return input.archive.hasAlbumPhoto({ chat, albumId: value.albumId, photoId: value.photoId, signal: value.signal, guard: value.guard });
    },
    close: () => input.archive.close(),
    forceClose: () => input.archive.forceClose(),
  };
}
