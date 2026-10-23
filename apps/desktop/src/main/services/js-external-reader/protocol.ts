import { Buffer } from 'node:buffer';
import type { NativeAttachmentDescriptor, NativeAttachmentMetadata, NativeCatalogRecord, NativeDirectoryRow, NativeSourceEnvelope,
  NativeStickerMetadata, OfficialAuthCandidate } from '@line-agent/contracts';

export const FRAME_LIMITS = Object.freeze({ controlBytes: 4096, initBytes: 16 * 1024, pageBytes: 1024 * 1024, initialImportPageBytes: 8 * 1024 * 1024 });

export type ProtocolFrame = Readonly<Record<string, unknown> & {
  version: 1;
  requestId: string;
  sequence: number;
  type: string;
}>;

/**
 * `read_official_identity` result payload: the account the official LINE on this
 * computer is currently logged in to (the active candidate only). `displayName`
 * is null when the database has no own `_contact` row.
 */
export type OfficialIdentity = Readonly<{ mid: string; displayName: string | null; picturePath?: string | null }>;

export type ImportCursor =Readonly<{ createdTime: string; id: string }>;
export type ImportMentionRange = Readonly<{ start: number; end: number; userId: string }>;
export type ImportRow = Readonly<{
  observationId: string;
  canonicalMessageId: null;
  nativeConversationKind: string;
  nativeConversationId: string;
  nativeMessageId: string;
  chatType: 'direct' | 'group' | 'room' | 'community' | 'thread' | 'unsupported';
  chatId: string;
  conversationTitle?: string | null;
  nativeMetadata?: Readonly<{ midType: number | null; parentChatId: string | null; communityId: string | null }>;
  nativeContentType?: number | null;
  nativePayload?: NativeSourceEnvelope & { table: '_message' };
  nativeStickerMetadata?: NativeStickerMetadata;
  nativeAttachments?: readonly NativeAttachmentDescriptor[];
  senderId: string;
  senderName?: string | null;
  senderPicturePath?: string | null;
  mentionRanges?: readonly ImportMentionRange[];
  kind: string;
  createdTime: string;
  text: string | null;
  readonlyForSending: boolean;
}>;
export type ImportSnapshotMetadata = Readonly<{
  sourceArchiveFormat: 1;
  sourceIdentityDigest: string;
  snapshotDigest: string;
  schemaVersion: string;
  highWatermark: ImportCursor | null;
  eligibleCount: string | null;
}>;
export type ImportCatalogPage = Readonly<{
  requestId: string;
  pageNumber: number;
  batchDigest: string;
  rows: readonly NativeCatalogRecord[];
  hasMore: boolean;
}>;
/** Friend names and computed conversation titles from the official directory tables; one pass per reader session. */
export type ImportDirectoryPage = Readonly<{
  requestId: string;
  pageNumber: number;
  batchDigest: string;
  rows: readonly NativeDirectoryRow[];
  hasMore: boolean;
}>;
export type ImportSnapshotPage = Readonly<{
  pageNumber: number;
  batchDigest: string;
  rows: readonly ImportRow[];
  lastCursor: ImportCursor | null;
  hasMore: boolean;
}>;
export type ImportSnapshotCompletion = Readonly<{
  sourceIdentityDigest: string;
  snapshotDigest: string;
  pageCount: number;
  rowCount: number;
  highWatermark: ImportCursor | null;
}>;
export type DirectMonitorPage = Readonly<{
  pageNumber: number;
  batchDigest: string;
  rows: readonly ImportRow[];
  tailRows: readonly ImportRow[];
  lastCursor: ImportCursor | null;
  hasMore: boolean;
  /** Present only on the page that delivers the last slice of the round tail: its complete key range and every row id. */
  tailWindow?: DirectTailWindow;
  /** Present only on the final page of a round, and only when LINE's own _unreadCount column was readable. */
  unreadCounts?: DirectUnreadCounts;
}>;
export type DirectUnreadCounts = Readonly<{ entries: readonly (readonly [string, number])[] }>;
export type DirectTailWindow = Readonly<{
  upper: ImportCursor;
  lower: ImportCursor | null;
  complete: true;
  ids: readonly string[];
}>;
export type NativeMonitorAccess = Readonly<{
  acquireAuthCandidates(signal?: AbortSignal): Promise<Readonly<{ candidates: readonly OfficialAuthCandidate[]; errorCode: string | null }>>;
  decodeAttachment(input: Readonly<{ envelope: NativeSourceEnvelope; expectedMessageId: string; expectedChatId: string }>,
    signal?: AbortSignal): Promise<Readonly<{ metadata: NativeAttachmentMetadata | null; errorCode: string | null }>>;
}>;
export type ImportProgress = Readonly<{
  phase: 'source_check' | 'close_line_window' | 'key_scan' | 'snapshot_copy' | 'snapshot_hash' | 'snapshot_reread' | 'count' | 'page_read';
  bytesCopied: string | null;
  totalBytes: string | null;
  rowsScanned: string | null;
  eligibleCount: string | null;
  scanSteps?: string | null;
}>;

/** Main commits each callback page before the reader sends its ACK. */
export interface OfficialSnapshotImportReader {
  readOfficialSnapshot(input: {
    bridgePath: string;
    requestRoot: string;
    requestId: string;
    expectedMid: string;
    deadlineUnixMs: number;
    mainIdentity: Readonly<{ pid: number; startedAt: string; imagePath: string; imageSha256: string }>;
    markerStore: import('./owner-ready-session.js').OwnerReadyMarkerStore;
    inspectProcess(pid: number): Promise<import('./owner-ready-session.js').OwnerProcessIdentity | null>;
    committedCursor: ImportCursor | null;
    /** Return the cursor permitted for this exact snapshot; return null after a source reset. */
    onReady(metadata: ImportSnapshotMetadata, signal?: AbortSignal): Promise<ImportCursor | null> | ImportCursor | null;
    onCatalogPage?(page: ImportCatalogPage, signal?: AbortSignal): Promise<void> | void;
    onDirectoryPage?(page: ImportDirectoryPage, signal?: AbortSignal): Promise<void> | void;
    onProgress(progress: ImportProgress, signal?: AbortSignal): Promise<void> | void;
    onPage(page: ImportSnapshotPage, signal?: AbortSignal): Promise<void> | void;
    signal?: AbortSignal;
  }): Promise<ImportSnapshotCompletion>;
}

export interface OfficialDirectMonitorReader {
  readOfficialMonitor(input: {
    bridgePath: string;
    requestRoot: string;
    requestId: string;
    expectedMid: string;
    sourceIdentityDigest: string;
    cursor: ImportCursor | null;
    deadlineUnixMs: number;
    mainIdentity: Readonly<{ pid: number; startedAt: string; imagePath: string; imageSha256: string }>;
    markerStore: import('./owner-ready-session.js').OwnerReadyMarkerStore;
    inspectProcess(pid: number): Promise<import('./owner-ready-session.js').OwnerProcessIdentity | null>;
    beforeCreate?(context: { signal: AbortSignal; deadlineUnixMs: number; trackSettlement(settlement: Promise<unknown>): void }): Promise<void> | void;
    onProgress(progress: ImportProgress, signal?: AbortSignal): Promise<void> | void;
    onDirectoryPage?(page: ImportDirectoryPage, signal?: AbortSignal): Promise<void> | void;
    onPage(page: DirectMonitorPage, signal?: AbortSignal): Promise<ImportCursor | null> | ImportCursor | null;
    signal?: AbortSignal;
    pollIntervalMs?: number;
  }): Promise<void>;
}

export function encodeFrame(value: unknown, maxBytes: number): Buffer {
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw new Error('frame_invalid');
  }
  if (!body.byteLength || body.byteLength > maxBytes) throw new Error('frame_too_large');
  const encoded = Buffer.allocUnsafe(4 + body.byteLength);
  encoded.writeUInt32BE(body.byteLength, 0);
  body.copy(encoded, 4);
  return encoded;
}

export class FrameDecoder {
  readonly #maxBytes: number;
  #header = Buffer.alloc(4);
  #headerLength = 0;
  #body: Buffer | undefined;
  #bodyLength = 0;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > FRAME_LIMITS.initialImportPageBytes) throw new Error('frame_limit_invalid');
    this.#maxBytes = maxBytes;
  }

  push(chunk: Uint8Array): ProtocolFrame[] {
    const frames: ProtocolFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!this.#body) {
        const copied = Math.min(4 - this.#headerLength, chunk.byteLength - offset);
        Buffer.from(chunk.buffer, chunk.byteOffset + offset, copied).copy(this.#header, this.#headerLength);
        this.#headerLength += copied;
        offset += copied;
        if (this.#headerLength < 4) continue;
        const length = this.#header.readUInt32BE(0);
        if (length < 2 || length > this.#maxBytes) throw new Error('frame_too_large');
        this.#body = Buffer.allocUnsafe(length);
        this.#bodyLength = 0;
      }

      const body = this.#body;
      const copied = Math.min(body.byteLength - this.#bodyLength, chunk.byteLength - offset);
      Buffer.from(chunk.buffer, chunk.byteOffset + offset, copied).copy(body, this.#bodyLength);
      this.#bodyLength += copied;
      offset += copied;
      if (this.#bodyLength === body.byteLength) {
        let decoded: unknown;
        try { decoded = JSON.parse(body.toString('utf8')); } catch { throw new Error('frame_invalid'); }
        if (!isProtocolFrame(decoded)) throw new Error('frame_invalid');
        frames.push(decoded);
        this.#header = Buffer.alloc(4);
        this.#headerLength = 0;
        this.#body = undefined;
        this.#bodyLength = 0;
      }
    }
    return frames;
  }

  get hasPartialFrame(): boolean { return this.#headerLength !== 0 || this.#body !== undefined; }
}

export function validateFrameEnvelope(value: unknown, input: {
  requestId: string;
  expectedSequence: number;
  allowedKeys: readonly string[];
}): value is ProtocolFrame {
  if (!isProtocolFrame(value) || value.requestId !== input.requestId || value.sequence !== input.expectedSequence) return false;
  const keys = Object.keys(value);
  const allowed = new Set(['version', 'requestId', 'sequence', 'type', ...input.allowedKeys]);
  return keys.length <= allowed.size && keys.every((key) => allowed.has(key));
}

function isProtocolFrame(value: unknown): value is ProtocolFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.version === 1 && typeof frame.requestId === 'string' && /^[0-9a-f]{32}$/.test(frame.requestId) &&
    Number.isSafeInteger(frame.sequence) && (frame.sequence as number) > 0 &&
    typeof frame.type === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(frame.type);
}
