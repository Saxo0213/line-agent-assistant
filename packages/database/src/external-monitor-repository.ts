import { createHash, randomUUID } from 'node:crypto';
import { ContactDescriptorSchema, InboundEnvelopeSchema, JsonValueSchema, normalizeNativePicturePath, type ContactDescriptor, type InboundEnvelope, type JsonValue } from '@line-agent/contracts';
import { Buffer } from 'node:buffer';
import type { Pool, PoolClient } from 'pg';
import { upsertLineContacts } from './name-resolution.js';
import { bridgeLiveMessage, bridgeNativeEnvelope, isRecalledNativeEnvelope, nativeChatEventMids } from './content-bridge/index.js';
import { loadChatEventNames } from './content-bridge/chat-event-names.js';
import { ChatTypeSchema, NativeCatalogRecordSchema, NativeSourceEnvelopeSchema, NativeStickerMetadataSchema,
  NativeAttachmentDescriptorSchema, NativeConversationMetadataSchema, NativeDirectoryRowSchema, normalizeMentionRanges, redactSensitiveString, redactSensitiveText, storedTextForKind, type ChatType, type MentionRange, type NativeAttachmentDescriptor, type NativeCatalogRecord,
  type MessageContent, type NativeConversationMetadata, type NativeDirectoryRow, type NativeSourceEnvelope, type NativeStickerMetadata } from '@line-agent/contracts';

const MAX_OBSERVATIONS = 100;
const MAX_INITIAL_IMPORT_OBSERVATIONS = 2000;
const MAX_BATCH_BYTES = 1_048_576;
const MAX_INITIAL_IMPORT_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_CATALOG_RECORDS = 1000;
const MAX_NATIVE_DIRECTORY_ROWS = 2000;
const MAX_NATIVE_CATALOG_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_CURSOR_BYTES = 16_384;
const MAX_EXTERNAL_MENTION_RANGES = 32;
const MAX_EXTERNAL_MENTION_USER_ID_LENGTH = 128;

export interface ExternalObservation {
  observationId: string;
  canonicalMessageId: string | null;
  nativeConversationKind?: string;
  nativeConversationId?: string;
  nativeMessageId?: string | null;
  chatType: ChatType;
  chatId: string;
  conversationTitle?: string | null;
  nativeMetadata?: NativeConversationMetadata;
  nativeContentType?: number | null;
  senderId: string;
  senderName?: string;
  senderPicturePath?: string | null;
  mentionIds?: string[];
  mentionRanges?: unknown;
  nativePayload?: NativeSourceEnvelope;
  livePayload?: { raw: JsonValue; eventId?: string; contact?: ContactDescriptor; recovery?: {
    envelope: InboundEnvelope; controlEpoch: number; receiptMode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; sensitive: boolean;
  } };
  nativeStickerMetadata?: NativeStickerMetadata;
  attachments?: NativeAttachmentDescriptor[];
  kind: string;
  text: string | null;
  occurredAt: string;
}
export interface ExternalObservationBatch {
  accountId: string;
  sourceId: string;
  generation: number;
  expectedModeRevision: number;
  expectedCheckpoint: Record<string, unknown> | null;
  batchId: string;
  cursor: Record<string, unknown>;
  /** Tail repair preserves every checkpoint position except the tail marker. */
  tail?: { marker: Record<string, unknown> };
  observations: ExternalObservation[];
  /** Strict first-import pages fail and roll back if any row cannot be projected. */
  initialImport?: boolean;
  signal?: AbortSignal;
}

export interface ExternalBatchFence {
  expectedModeRevision: number;
  expectedCheckpoint: Record<string, unknown> | null;
}

export interface ExternalBatchResult {
  staged: number;
  projected: number;
  conflicts: number;
  replayed: boolean;
  changedMessages: ExternalChangedMessage[];
}

export interface ExternalChangedMessage {
  chatType: ChatType;
  chatId: string;
  messageId: string;
}

/** Projects a staged copy with the canonical source conversion. Caller owns the transaction and authority check. */
export async function projectStagedSourceObservation(client: PoolClient, input: {
  accountId: string; sourceId: string; generation: number; observation: ExternalObservation;
  origin: 'SYSTEM_LOGIN_LIVE' | 'SYSTEM_LOGIN_HISTORY' | 'EXTERNAL_MONITOR';
}): Promise<boolean> {
  const observation = input.observation;
  if (!observation.canonicalMessageId) return false;
  const changed = await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, observation,
    input.origin === 'SYSTEM_LOGIN_LIVE' ? 'live' : 'history');
  await client.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
    VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT(source_id,generation,observation_id)
    DO UPDATE SET origin=CASE WHEN message_source_provenance.origin='SYSTEM_LOGIN_LIVE'
      AND EXCLUDED.origin='SYSTEM_LOGIN_HISTORY' THEN message_source_provenance.origin ELSE EXCLUDED.origin END`,
  [input.accountId, observation.canonicalMessageId, input.sourceId, input.generation, observation.observationId, input.origin]);
  await client.query(`UPDATE external_source_observations SET status='PROJECTED'
    WHERE source_id=$1 AND generation=$2 AND observation_id=$3`, [input.sourceId, input.generation, observation.observationId]);
  return changed;
}

/** Login observations use the same source-copy table and canonical projector as monitor imports. */
export async function stageSystemLoginObservation(client: PoolClient, input: {
  accountId: string; sourceId: string; generation: number; batchId: string;
  origin: 'SYSTEM_LOGIN_LIVE' | 'SYSTEM_LOGIN_HISTORY'; observation: ExternalObservation; captureCanonicalExistence?: boolean;
}): Promise<{ changed: boolean; conflict: boolean; canonicalExisted?: boolean }> {
  let observation = normalizeObservation(input.observation);
  if (!observation.canonicalMessageId) return { changed: false, conflict: false };
  if (observation.livePayload?.recovery && observation.livePayload.recovery.envelope.accountId !== input.accountId) {
    throw new Error('Mismatched login recovery account');
  }
  let normalizedJson = stableJson(observation);
  let normalizedDigest = canonicalDigest(observation);
  const captureCanonicalExistence = async () => input.captureCanonicalExistence === true
    ? Boolean((await client.query('SELECT 1 FROM messages WHERE account_id=$1 AND message_id=$2',
      [input.accountId, observation.canonicalMessageId])).rowCount)
    : undefined;
  const inserted = await client.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,
      canonical_message_id,normalized_digest,normalized_payload,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'STAGED') ON CONFLICT(source_id,generation,observation_id) DO NOTHING RETURNING observation_id`,
  [input.sourceId, input.accountId, input.generation, observation.observationId, input.batchId,
    observation.canonicalMessageId, normalizedDigest, normalizedJson]);
  if (!inserted.rowCount) {
    const prior = await client.query<{ normalized_digest: string; status: string; canonical_message_id: string | null;
      normalized_payload: ExternalObservation }>(
      `SELECT normalized_digest,status,canonical_message_id,normalized_payload FROM external_source_observations
       WHERE source_id=$1 AND generation=$2 AND observation_id=$3 FOR UPDATE`,
    [input.sourceId, input.generation, observation.observationId]);
    const stored = prior.rows[0];
    if (!stored || stored.canonical_message_id !== observation.canonicalMessageId) return { changed: false, conflict: true };
    const firstRecovery = stored.normalized_payload.livePayload?.recovery;
    if (firstRecovery) {
      observation = normalizeObservation({ ...observation, livePayload: {
        ...(observation.livePayload ?? { raw: {} }), recovery: firstRecovery,
      } });
      normalizedJson = stableJson(observation);
      normalizedDigest = canonicalDigest(observation);
    }
    if (stored.normalized_digest !== normalizedDigest) {
      const previous = stored.normalized_payload;
      const stableLoginIdentity = stored.status === 'PROJECTED'
        && previous.nativeConversationKind === observation.nativeConversationKind
        && previous.nativeConversationId === observation.nativeConversationId
        && previous.nativeMessageId === observation.nativeMessageId
        && previous.chatType === observation.chatType && previous.chatId === observation.chatId
        && previous.senderId === observation.senderId && previous.occurredAt === observation.occurredAt;
      if (!stableLoginIdentity) return { changed: false, conflict: true };
      if (isLoginRecallObservation(previous) && !isLoginRecallObservation(observation)) {
        const canonicalExisted = await captureCanonicalExistence();
        return { changed: false, conflict: false,
          ...(input.captureCanonicalExistence === true ? { canonicalExisted: canonicalExisted === true } : {}) };
      }
      await client.query(`UPDATE external_source_observations SET batch_id=$4,canonical_message_id=$5,
        normalized_digest=$6,normalized_payload=$7::jsonb,conflict_reason=NULL
        WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
      [input.sourceId, input.generation, observation.observationId, input.batchId, observation.canonicalMessageId,
        normalizedDigest, normalizedJson]);
    } else if (stored.status === 'CONFLICT') return { changed: false, conflict: true };
    else if (stableJson({ mentionIds: stored.normalized_payload.mentionIds, mentionRanges: stored.normalized_payload.mentionRanges })
      !== stableJson({ mentionIds: observation.mentionIds, mentionRanges: observation.mentionRanges })) {
      await client.query(`UPDATE external_source_observations SET normalized_payload=$4::jsonb
        WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
      [input.sourceId, input.generation, observation.observationId, normalizedJson]);
    }
  }
  // The source observation row is locked above. Callers that need inserted/duplicate
  // accounting capture canonical existence here, before the shared projector locks it.
  const canonicalExisted = await captureCanonicalExistence();
  return { changed: await projectStagedSourceObservation(client, { ...input, observation }), conflict: false,
    ...(input.captureCanonicalExistence === true ? { canonicalExisted: canonicalExisted === true } : {}) };
}

export interface ExternalDirectPollInput {
  accountId: string;
  sourceId: string;
  generation: number;
  expectedModeRevision: number;
  expectedCheckpoint: Record<string, unknown> | null;
  batchId: string;
  cursor: Record<string, unknown>;
  forwardObservations: ExternalObservation[];
  tailObservations: ExternalObservation[];
  /** Complete round-tail key range plus every source row id in it; source-deleted detection runs only when present. */
  tailWindow?: ExternalTailWindow;
  /** LINE's own per-chat unread counts (counts above zero only). When present, this account's conversations mirror it. */
  unreadCounts?: { entries: [string, number][] };
  signal?: AbortSignal;
}

export interface ExternalTailCursor { createdTime: string; id: string }
export interface ExternalTailWindow {
  upper: ExternalTailCursor;
  /** Oldest tail row key when the tail is full; null means the range extends to the start of the table. */
  lower: ExternalTailCursor | null;
  ids: string[];
}

export interface ExternalDirectPollResult extends ExternalBatchResult {
  tailRepaired: number;
  /** Conversations whose unread_count changed to mirror LINE. */
  unreadChanged: number;
}

function normalizeUnreadCounts(value: { entries: [string, number][] } | undefined): [string, number][] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.entries) || value.entries.length > 2000) {
    throw new Error('Invalid external unread counts');
  }
  const seen = new Set<string>();
  const entries: [string, number][] = [];
  for (const entry of value.entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid external unread counts');
    const [chatId, count] = entry as [unknown, unknown];
    if (typeof chatId !== 'string' || !chatId || chatId.length > 512 || seen.has(chatId)
      || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
      throw new Error('Invalid external unread counts');
    }
    seen.add(chatId);
    entries.push([chatId, count]);
  }
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export interface ExternalInitialImportState {
  sourceId: string;
  generation: number;
  initialImportComplete: boolean;
  committedCount: string;
  highWater: Record<string, unknown> | null;
  eligibleCount: string | null;
  snapshotDigest: string | null;
  schemaVersion: string | null;
  sourceIdentityDigest: string;
  cursor: Record<string, unknown>;
}

export interface NativeDirectoryPageResult {
  contacts: number;
  contactsChanged: number;
  conversationsChanged: number;
}

export interface NativeCatalogPageResult {
  stored: number;
  changed: number;
  replayed: boolean;
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid external observation ${label}`);
  return value;
}
function normalizeObservation(value: ExternalObservation): ExternalObservation {
  const observationId = requiredText(value.observationId, 'id', 512);
  if (value.canonicalMessageId !== null) requiredText(value.canonicalMessageId, 'canonical message ID', 512);
  if (!ChatTypeSchema.safeParse(value.chatType).success) throw new Error('Invalid external observation chat type');
  const chatId = requiredText(value.chatId, 'chat ID', 512);
  const senderId = value.senderId === '' ? '' : requiredText(value.senderId, 'sender ID', 512);
  const kind = requiredText(value.kind, 'kind', 64);
  const nativeConversationKind = requiredText(value.nativeConversationKind ?? value.chatType, 'native conversation kind', 64);
  const nativeConversationId = requiredText(value.nativeConversationId ?? value.chatId, 'native conversation ID', 512);
  const suppliedNativeMessageId = value.nativeMessageId ?? null;
  if (value.nativeMessageId !== undefined && value.canonicalMessageId !== null && value.canonicalMessageId !== value.nativeMessageId) {
    throw new Error('Conflicting external native message IDs');
  }
  const nativeMessageId = suppliedNativeMessageId === null ? null
    : requiredText(suppliedNativeMessageId, 'native message ID', 512);
  const legacyMessageId = value.canonicalMessageId === null ? null : requiredText(value.canonicalMessageId, 'canonical message ID', 512);
  const conversationTitle = value.conversationTitle === undefined || value.conversationTitle === null ? null
    : typeof value.conversationTitle === 'string' && value.conversationTitle.length <= 256 ? value.conversationTitle
      : (() => { throw new Error('Invalid external observation conversation title'); })();
  const nativeMetadata = value.nativeMetadata === undefined ? undefined : NativeConversationMetadataSchema.parse(value.nativeMetadata);
  const nativePayload = value.nativePayload === undefined ? undefined : NativeSourceEnvelopeSchema.parse(value.nativePayload);
  if (nativePayload && nativePayload.table !== '_message') throw new Error('Invalid external native message payload table');
  const livePayload = value.livePayload === undefined ? undefined : (() => {
    if (!value.livePayload || typeof value.livePayload !== 'object' || Array.isArray(value.livePayload)) throw new Error('Invalid login live payload');
    const raw = JsonValueSchema.parse(value.livePayload.raw);
    const serializedBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    if (serializedBytes > 256 * 1024) throw new Error('Login live payload exceeds size limit');
    const contact = value.livePayload.contact === undefined ? undefined : ContactDescriptorSchema.parse(value.livePayload.contact);
    const eventId = value.livePayload.eventId === undefined ? undefined : requiredText(value.livePayload.eventId, 'login event ID', 512);
    const recovery = value.livePayload.recovery === undefined ? undefined : (() => {
      const candidate = value.livePayload!.recovery;
      if (!candidate || !Number.isSafeInteger(candidate.controlEpoch) || candidate.controlEpoch < 0
        || !['ACTIVE_CONTROL', 'MONITOR_ONLY', 'PAUSED'].includes(candidate.receiptMode) || typeof candidate.sensitive !== 'boolean') {
        throw new Error('Invalid login recovery receipt');
      }
      const envelope = InboundEnvelopeSchema.parse(candidate.envelope);
      if (envelope.ingestion.source !== 'live' || envelope.messageId !== (nativeMessageId ?? legacyMessageId)
        || envelope.chatType !== value.chatType || envelope.chatId !== value.chatId || envelope.senderId !== value.senderId) {
        throw new Error('Mismatched login recovery envelope');
      }
      if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 256 * 1024) throw new Error('Login recovery envelope exceeds size limit');
      return { envelope, controlEpoch: candidate.controlEpoch, receiptMode: candidate.receiptMode, sensitive: candidate.sensitive };
    })();
    return { raw, ...(eventId === undefined ? {} : { eventId }), ...(contact === undefined ? {} : { contact }),
      ...(recovery === undefined ? {} : { recovery }) };
  })();
  const nativeStickerMetadata = value.nativeStickerMetadata === undefined ? undefined
    : NativeStickerMetadataSchema.safeParse(value.nativeStickerMetadata).success
      ? NativeStickerMetadataSchema.parse(value.nativeStickerMetadata) : undefined;
  const attachments = value.attachments === undefined ? undefined
    : Array.isArray(value.attachments) && value.attachments.length <= 32
      ? value.attachments.map((item) => {
        const descriptor = NativeAttachmentDescriptorSchema.parse(item);
        // Same secret rules as the live path (name/mimeType), applied before the digest.
        return { ...descriptor,
          name: descriptor.name === null || descriptor.name === undefined ? descriptor.name : redactSensitiveString(descriptor.name),
          mimeType: descriptor.mimeType === null || descriptor.mimeType === undefined ? descriptor.mimeType : redactSensitiveString(descriptor.mimeType) };
      })
      : (() => { throw new Error('Invalid external native attachment descriptors'); })();
  const senderName = typeof value.senderName === 'string' && value.senderName.trim().length > 0 && value.senderName.length <= 256 && !value.senderName.includes('\0')
    ? value.senderName : undefined;
  const senderPicturePath = normalizeNativePicturePath(value.senderPicturePath);
  if (value.nativeContentType !== undefined && value.nativeContentType !== null
    && (!Number.isSafeInteger(value.nativeContentType) || value.nativeContentType < 0)) throw new Error('Invalid external observation native content type');
  if (value.text !== null && typeof value.text !== 'string') throw new Error('Invalid external observation text');
  const date = new Date(value.occurredAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid external observation timestamp');
  const sourceText = value.text?.replace(/\0/gu, '\uFFFD') ?? null;
  // Shared storage contract (packages/contracts redaction.ts): in-place secret replacement with
  // recomputed mention ranges, and a text body only for kind 'text'.
  const sourceRanges = normalizeExternalMentionRanges(sourceText, value.mentionRanges);
  const redaction = sourceText === null ? null : redactSensitiveText(sourceText, sourceRanges ?? []);
  const text = storedTextForKind(kind, redaction?.text ?? null);
  const mentionRanges = sourceRanges === undefined ? undefined
    : text === null ? [] : normalizeMentionRanges(text, redaction!.mentionRanges);
  const mentionIds = value.mentionIds === undefined ? undefined : (() => {
    if (!Array.isArray(value.mentionIds) || value.mentionIds.length > 128
      || value.mentionIds.some((id) => typeof id !== 'string' || !id || id.length > 512)) {
      throw new Error('Invalid external observation mention IDs');
    }
    return [...new Set(value.mentionIds)];
  })();
  return { observationId, canonicalMessageId: nativeMessageId ?? (legacyMessageId
    ? externalArchiveKey(nativeConversationKind, nativeConversationId, legacyMessageId) : null),
    nativeConversationKind, nativeConversationId, nativeMessageId: nativeMessageId ?? legacyMessageId,
    chatType: value.chatType, chatId, conversationTitle, ...(nativeMetadata === undefined ? {} : { nativeMetadata }),
    nativeContentType: value.nativeContentType ?? null, senderId, ...(senderName === undefined ? {} : { senderName }),
    ...(senderPicturePath === null ? {} : { senderPicturePath }),
    ...(mentionIds === undefined ? {} : { mentionIds }),
    ...(mentionRanges === undefined ? {} : { mentionRanges }), ...(nativePayload === undefined ? {} : { nativePayload }),
    ...(livePayload === undefined ? {} : { livePayload }),
    ...(nativeStickerMetadata === undefined ? {} : { nativeStickerMetadata }), ...(attachments === undefined ? {} : { attachments }),
    kind, text, occurredAt: date.toISOString() };
}

function normalizeExternalMentionRanges(sourceText: string | null, value: unknown): MentionRange[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_EXTERNAL_MENTION_RANGES) return undefined;
  const sourceRanges = normalizeMentionRanges(sourceText, value);
  if (sourceRanges.length !== value.length || sourceRanges.some((range) => range.userId.length > MAX_EXTERNAL_MENTION_USER_ID_LENGTH)) return undefined;
  return sourceRanges;
}

function externalArchiveKey(conversationKind: string, conversationId: string, messageId: string): string {
  const hash = createHash('sha256');
  for (const value of ['official-line-db', conversationKind, conversationId, messageId]) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `ext1:${hash.digest('hex')}`;
}
function canonicalDigest(observation: ExternalObservation): string {
  return digest(stableJson({ messageId: observation.canonicalMessageId, chatType: observation.chatType, chatId: observation.chatId,
    conversationTitle: observation.conversationTitle, nativeMetadata: observation.nativeMetadata,
    nativeContentType: observation.nativeContentType, senderId: observation.senderId, kind: observation.kind,
    ...(observation.nativePayload === undefined ? {} : { nativeSourceDigest: observation.nativePayload.sourceDigest }),
    ...(observation.livePayload === undefined ? {} : { livePayload: observation.livePayload }),
    ...(observation.nativeStickerMetadata === undefined ? {} : { nativeStickerMetadata: observation.nativeStickerMetadata }),
    ...(observation.attachments === undefined ? {} : { attachments: observation.attachments }),
    text: observation.text, occurredAt: observation.occurredAt }));
}

function isLoginRecallObservation(observation: ExternalObservation): boolean {
  if (observation.nativePayload && isRecalledNativeEnvelope(observation.nativePayload)) return true;
  if (!observation.livePayload) return false;
  return bridgeLiveMessage({ raw: observation.livePayload.raw, contact: observation.livePayload.contact })?.content?.type === 'unsent';
}

/**
 * An unchanged source digest keeps the stored envelope (Layer 1 is write-once per source row). The one exception: a
 * stored `dpapi` envelope is replaced by the same row's `plain` envelope even when the digest is equal, so the
 * bridge can read it.
 */
function keepsStoredEnvelope(stored: NativeSourceEnvelope | undefined, incoming: NativeSourceEnvelope): stored is NativeSourceEnvelope {
  return stored !== undefined && stored.sourceDigest === incoming.sourceDigest
    && !(stored.encoding === 'dpapi' && incoming.encoding === 'plain');
}

function mergeStoredNativeFields(incoming: ExternalObservation, stored: ExternalObservation | null | undefined,
  archivedNativePayload?: unknown): ExternalObservation {
  const archivedParsed = NativeSourceEnvelopeSchema.safeParse(archivedNativePayload);
  const archived = archivedParsed.success && archivedParsed.data.table === '_message' ? archivedParsed.data : undefined;
  const prior = stored?.nativePayload;
  let nativePayload = incoming.nativePayload;
  if (incoming.nativePayload) {
    if (keepsStoredEnvelope(archived, incoming.nativePayload)) nativePayload = archived;
    else if (keepsStoredEnvelope(prior, incoming.nativePayload)) nativePayload = prior;
  } else nativePayload = archived ?? prior;
  const nativeStickerMetadata = incoming.nativeStickerMetadata ?? stored?.nativeStickerMetadata;
  const attachments = mergeAttachmentDescriptors(incoming.attachments, stored?.attachments);
  return { ...incoming, ...(nativePayload === undefined ? {} : { nativePayload }),
    ...(nativeStickerMetadata === undefined ? {} : { nativeStickerMetadata }), ...(attachments === undefined ? {} : { attachments }) };
}

function mergeAttachmentDescriptors(incoming: ExternalObservation['attachments'], stored: ExternalObservation['attachments']) {
  if (incoming === undefined) return stored;
  const storedById = new Map((stored ?? []).map((item) => [item.id, item]));
  const merged = new Map((stored ?? []).map((item) => [item.id, item]));
  for (const item of incoming) {
    const prior = storedById.get(item.id);
    merged.set(item.id, prior ? { ...prior, ...item,
      name: item.name ?? prior.name, mimeType: item.mimeType ?? prior.mimeType,
      sizeBytes: item.sizeBytes ?? prior.sizeBytes, expiresAt: item.expiresAt ?? prior.expiresAt } : item);
  }
  return [...merged.values()];
}

function nativeFieldsDiffer(left: ExternalObservation | null | undefined, right: ExternalObservation): boolean {
  return stableJson(left?.nativePayload ?? null) !== stableJson(right.nativePayload ?? null)
    || stableJson(left?.nativeStickerMetadata ?? null) !== stableJson(right.nativeStickerMetadata ?? null)
    || stableJson(left?.attachments ?? null) !== stableJson(right.attachments ?? null);
}

export class ExternalMonitorRepository {
  private pendingImportAcquisitions = 0;
  constructor(private readonly pool: Pool) {}

  private async withImportOperation<T>(signal: AbortSignal | undefined, transaction: boolean,
    operation: (client: PoolClient) => Promise<T>, enforceDeadline = true): Promise<T> {
    if (signal?.aborted) throw new Error('External import database operation cancelled');
    if (this.pendingImportAcquisitions >= 2) throw new Error('External import database admission limit exceeded');
    let connection: PoolClient | undefined;
    let released = false;
    let stopped = false;
    const release = (destroy = false) => {
      if (!connection || released) return;
      released = true;
      connection.release(destroy);
    };
    let rejectStop!: (error: Error) => void;
    const stoppedPromise = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (message: string) => {
      if (stopped) return;
      stopped = true;
      release(true);
      rejectStop(new Error(message));
    };
    const onAbort = () => stop('External import database operation cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = enforceDeadline ? setTimeout(() => stop('External import database operation deadline exceeded'), 15_000) : undefined;
    this.pendingImportAcquisitions += 1;
    let acquisitionSettled = false;
    const acquisition = Promise.resolve().then(() => this.pool.connect()).then((client) => {
      acquisitionSettled = true;
      this.pendingImportAcquisitions -= 1;
      connection = client;
      if (stopped) release(true);
      return client;
    }, (error: unknown) => {
      acquisitionSettled = true;
      this.pendingImportAcquisitions -= 1;
      throw error;
    });
    let boundedClient: PoolClient | undefined;
    try {
      const acquired = await Promise.race([acquisition, stoppedPromise]);
      boundedClient = new Proxy(acquired, { get(target, property) {
        if (property === 'query') return (...args: Parameters<PoolClient['query']>) => Promise.race([
          Reflect.apply(target.query, target, args), stoppedPromise,
        ]);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as PoolClient;
      if (transaction) {
        await boundedClient.query('BEGIN');
        await boundedClient.query(enforceDeadline ? "SET LOCAL statement_timeout = '12000ms'" : 'SET LOCAL statement_timeout = 0');
        await boundedClient.query("SET LOCAL lock_timeout = '4000ms'");
      }
      const result = await operation(boundedClient);
      if (signal?.aborted) throw new Error('External import database operation cancelled');
      if (transaction) await boundedClient.query('COMMIT');
      if (signal?.aborted) throw new Error('External import database operation cancelled');
      return result;
    } catch (error) {
      if (transaction && boundedClient && !stopped) {
        try { await boundedClient.query('ROLLBACK'); }
        catch { stopped = true; }
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      release(stopped || signal?.aborted === true);
      if (!acquisitionSettled) void acquisition.then(() => release(true), () => undefined);
    }
  }

  /** Read the selected source's current CAS values before asking its reader for another bounded page. */
  async readBatchFence(input: { accountId: string; sourceId: string; generation: number; signal?: AbortSignal }): Promise<ExternalBatchFence> {
    requiredText(input.accountId, 'account ID', 512);
    requiredText(input.sourceId, 'source ID', 64);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid external source generation');
    return this.withImportOperation(input.signal, false, async (client) => {
    const result = await client.query<{ mode_revision: string; cursor: Record<string, unknown> | null;
      own_mid: string | null; verified_account_mid: string; source_state: string; product_role: string | null;
      transition_state: string; connection_mode: string; admin_binding_account_id: string | null;
      admin_binding_mid: string | null; admin_binding_version: string | null; agent_role: string | null;
      current_admin_mid: string | null; current_admin_version: string | null }>(
      `SELECT a.mode_revision,c.cursor,a.own_mid,s.verified_account_mid,s.state AS source_state,a.product_role,
        a.source_transition_state AS transition_state,a.connection_mode,s.admin_binding_account_id,
        s.admin_binding_mid,s.admin_binding_version,agent.product_role AS agent_role,
        admin.user_id AS current_admin_mid,av.version AS current_admin_version
       FROM line_accounts a JOIN line_account_sources s
        ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
       LEFT JOIN external_source_checkpoints c ON c.source_id=s.source_id AND c.account_id=a.account_id AND c.generation=s.generation
       JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
       JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
       JOIN account_administrator_versions av ON av.account_id=agent.account_id
       WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 AND s.source_type='EXTERNAL_MONITOR'`,
      [input.accountId, input.sourceId, input.generation]);
    const row = result.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
    if (!row || row.source_state !== 'ACTIVE' || row.own_mid !== row.verified_account_mid
      || row.product_role !== 'PRIMARY_ADMIN' || row.transition_state !== 'STABLE' || row.connection_mode !== 'EXTERNAL_MONITOR'
      || !row.admin_binding_account_id || !row.admin_binding_mid || !row.admin_binding_version || row.agent_role !== 'AGENT'
      || row.admin_binding_mid !== row.own_mid || row.current_admin_mid !== row.admin_binding_mid
      || Number(row.current_admin_version) !== Number(row.admin_binding_version)) {
      throw new Error('External source authority is stale');
    }
    return { expectedModeRevision: Number(row.mode_revision), expectedCheckpoint: row.cursor };
    });
  }

  async bindVerifiedExternalSource(input: { accountId: string; ownMid: string; sourceIdentity?: string;
    sourceIdentityDigest?: string; initialImport?: { snapshotDigest: string; schemaVersion: string;
      highWater: Record<string, unknown> | null; eligibleCount: string | null }; signal?: AbortSignal }): Promise<{
    sourceId: string; generation: number; modeRevision: number;
  }> {
    requiredText(input.accountId, 'account ID', 512);
    requiredText(input.ownMid, 'verified LINE MID', 512);
    if ((input.sourceIdentity === undefined) === (input.sourceIdentityDigest === undefined)) throw new Error('External source identity is required');
    const sourceIdentity = input.sourceIdentity === undefined ? null : requiredText(input.sourceIdentity, 'source identity', 4096);
    if (input.sourceIdentityDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceIdentityDigest)) throw new Error('Invalid external source identity digest');
    if (input.initialImport && (!/^[a-f0-9]{64}$/.test(input.initialImport.snapshotDigest)
      || !requiredText(input.initialImport.schemaVersion, 'schema version', 64)
      || (input.initialImport.eligibleCount !== null && !/^(0|[1-9]\d*)$/.test(input.initialImport.eligibleCount))
      || (input.initialImport.highWater !== null && (!input.initialImport.highWater || typeof input.initialImport.highWater !== 'object'
        || Array.isArray(input.initialImport.highWater)
        || Buffer.byteLength(stableJson(input.initialImport.highWater), 'utf8') > MAX_CURSOR_BYTES)))) throw new Error('Invalid external initial import metadata');
    const identityDigest = input.sourceIdentityDigest ?? digest(sourceIdentity!);
    return this.withImportOperation(input.signal, true, async (client) => {
      const account = await client.query<{ own_mid: string | null; selected_source_id: string | null; selected_source_generation: string | null;
        connection_mode: string; product_role: string | null; mode_revision: string }>(
        'SELECT own_mid, selected_source_id, selected_source_generation, connection_mode,product_role,mode_revision FROM line_accounts WHERE account_id=$1 FOR UPDATE', [input.accountId]);
      if (!account.rows[0] || account.rows[0].product_role !== 'PRIMARY_ADMIN') throw new Error('External monitoring requires a configured Primary Admin account');
      if (account.rows[0].own_mid !== input.ownMid) throw new Error('Verified LINE account identity mismatch');
      const adminBinding = await client.query<{ account_id: string; user_id: string; version: string }>(
        `SELECT agent.account_id,admin.user_id,v.version FROM line_accounts agent
         JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
         JOIN account_administrator_versions v ON v.account_id=agent.account_id
         WHERE agent.product_role='AGENT' AND admin.user_id=$1 FOR SHARE OF agent,admin,v`, [input.ownMid]);
      // No Agent account yet: the Primary Admin slot's verified official identity is the only authority, so the source
      // records no administrator binding. Any binding to another MID is still rejected.
      const noAgentBinding = !adminBinding.rows[0]
        && !(await client.query("SELECT 1 FROM account_administrators WHERE role='PRIMARY_ADMIN' FOR SHARE")).rowCount;
      if (!adminBinding.rows[0] && !noAgentBinding) throw new Error('External monitoring requires a verified Agent administrator binding');
      const boundAdmin = adminBinding.rows[0] ?? null;
      if (account.rows[0].selected_source_id) {
        const current = await client.query<{ source_id: string; generation: string; identity_digest: string; source_type: string; state: string;
          admin_binding_account_id: string | null; admin_binding_mid: string | null; admin_binding_version: string | null }>(
          'SELECT source_id,generation,identity_digest,source_type,state,admin_binding_account_id,admin_binding_mid,admin_binding_version FROM line_account_sources WHERE source_id=$1 FOR UPDATE',
          [account.rows[0].selected_source_id]);
        if (current.rows[0]?.source_type === 'EXTERNAL_MONITOR' && current.rows[0].identity_digest === identityDigest
          && current.rows[0].state === 'ACTIVE' && account.rows[0].connection_mode === 'EXTERNAL_MONITOR'
          && (boundAdmin === null
            ? current.rows[0].admin_binding_account_id === null
            : current.rows[0].admin_binding_account_id === boundAdmin.account_id
              && current.rows[0].admin_binding_mid === boundAdmin.user_id
              && Number(current.rows[0].admin_binding_version) === Number(boundAdmin.version))) {
          if (input.initialImport) {
            const checkpoint = await client.query('SELECT 1 FROM external_source_checkpoints WHERE source_id=$1 FOR UPDATE', [current.rows[0].source_id]);
            if (!checkpoint.rowCount) await client.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor,
              initial_import_complete,committed_count,high_water,eligible_count,snapshot_digest,import_schema_version,updated_at)
              VALUES ($1,$2,$3,'{}'::jsonb,false,0,$4::jsonb,$5,$6,$7,now())`,
            [current.rows[0].source_id, input.accountId, current.rows[0].generation,
              input.initialImport.highWater === null ? null : stableJson(input.initialImport.highWater), input.initialImport.eligibleCount,
              input.initialImport.snapshotDigest, input.initialImport.schemaVersion]);
          }
          return { sourceId: current.rows[0].source_id, generation: Number(current.rows[0].generation), modeRevision: Number(account.rows[0].mode_revision) };
        }
      }
      const next = await client.query<{ generation: string }>(
        "SELECT COALESCE(max(generation),0)+1 AS generation FROM line_account_sources WHERE account_id=$1 AND source_type='EXTERNAL_MONITOR'", [input.accountId]);
      const generation = Number(next.rows[0]!.generation);
      const sourceId = randomUUID();
      await client.query("UPDATE line_account_sources SET state='RETIRED', retired_at=now() WHERE account_id=$1 AND source_type='EXTERNAL_MONITOR' AND state<>'RETIRED'", [input.accountId]);
      await client.query(`INSERT INTO line_account_sources(source_id,account_id,source_type,generation,identity_digest,verified_account_mid,
        state,read_capability,write_capability,admin_binding_account_id,admin_binding_mid,admin_binding_version)
        VALUES ($1,$2,'EXTERNAL_MONITOR',$3,$4,$5,'ACTIVE',true,false,$6,$7,$8)`,
      [sourceId, input.accountId, generation, identityDigest, input.ownMid, boundAdmin?.account_id ?? null,
        boundAdmin?.user_id ?? null, boundAdmin?.version ?? null]);
      if (input.initialImport) {
        await client.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor,initial_import_complete,
          committed_count,high_water,eligible_count,snapshot_digest,import_schema_version,updated_at)
          VALUES ($1,$2,$3,'{}'::jsonb,false,0,$4::jsonb,$5,$6,$7,now())`,
        [sourceId, input.accountId, generation, input.initialImport.highWater === null ? null : stableJson(input.initialImport.highWater),
          input.initialImport.eligibleCount, input.initialImport.snapshotDigest, input.initialImport.schemaVersion]);
      }
      await client.query(`UPDATE line_accounts SET connection_mode='EXTERNAL_MONITOR', selected_source_id=$2, selected_source_generation=$3,
        mode_revision=mode_revision+1, source_transition_state='STABLE', updated_at=now() WHERE account_id=$1`,
      [input.accountId, sourceId, generation]);
      return { sourceId, generation, modeRevision: Number(account.rows[0].mode_revision) + 1 };
    });
  }

  async getInitialImportState(input: { accountId: string; sourceId: string; generation: number; signal?: AbortSignal }): Promise<ExternalInitialImportState | null> {
    return this.withImportOperation(input.signal, false, async (client) => {
    const result = await client.query<{ initial_import_complete: boolean; committed_count: string; high_water: Record<string, unknown> | null;
      eligible_count: string | null; snapshot_digest: string | null; import_schema_version: string | null;
      identity_digest: string; cursor: Record<string, unknown> }>(`SELECT c.initial_import_complete,c.committed_count,c.high_water,c.eligible_count,c.snapshot_digest,c.import_schema_version,
        s.identity_digest,c.cursor
      FROM external_source_checkpoints c JOIN line_account_sources s USING(source_id,account_id,generation)
      JOIN line_accounts a ON a.account_id=s.account_id AND a.selected_source_id=s.source_id AND a.selected_source_generation=s.generation
      WHERE c.account_id=$1 AND c.source_id=$2 AND c.generation=$3 AND s.source_type='EXTERNAL_MONITOR'`,
    [input.accountId, input.sourceId, input.generation]);
    const row = result.rows[0];
    return row ? { accountId: input.accountId, sourceId: input.sourceId, generation: input.generation,
      initialImportComplete: row.initial_import_complete, committedCount: row.committed_count,
      highWater: row.high_water, eligibleCount: row.eligible_count,
      snapshotDigest: row.snapshot_digest, schemaVersion: row.import_schema_version, sourceIdentityDigest: row.identity_digest,
      cursor: row.cursor } : null;
    });
  }

  async resetUnfinishedInitialImport(input: { accountId: string; sourceId: string; generation: number; expectedModeRevision: number;
    expectedCheckpoint: Record<string, unknown>; sourceIdentityDigest: string; snapshotDigest: string; schemaVersion: string;
    highWater: Record<string, unknown> | null; eligibleCount: string | null; signal?: AbortSignal }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.sourceIdentityDigest) || !/^[a-f0-9]{64}$/.test(input.snapshotDigest)
      || !requiredText(input.schemaVersion, 'schema version', 64)
      || (input.eligibleCount !== null && !/^(0|[1-9]\d*)$/.test(input.eligibleCount))) throw new Error('Invalid external import reset metadata');
    return this.withImportOperation(input.signal, true, async (client) => {
      const source = await client.query<{ mode_revision: string; identity_digest: string; state: string; source_type: string;
        connection_mode: string; transition_state: string; own_mid: string | null; verified_account_mid: string;
        admin_binding_mid: string | null; current_admin_mid: string | null; admin_binding_version: string | null;
        current_admin_version: string | null; product_role: string | null; agent_role: string | null; read_capability: boolean }>(
        `SELECT a.mode_revision,s.identity_digest,s.state,s.source_type,a.connection_mode,a.source_transition_state AS transition_state,
          a.own_mid,s.verified_account_mid,s.admin_binding_mid,admin.user_id AS current_admin_mid,
          s.admin_binding_version,av.version AS current_admin_version,a.product_role,agent.product_role AS agent_role,s.read_capability
         FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
          AND s.generation=a.selected_source_generation JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
         JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
         JOIN account_administrator_versions av ON av.account_id=agent.account_id
         WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 FOR UPDATE OF a,s,agent,admin,av`,
        [input.accountId, input.sourceId, input.generation]);
      const row = source.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
      if (!row || Number(row.mode_revision) !== input.expectedModeRevision || row.identity_digest !== input.sourceIdentityDigest
        || row.state !== 'ACTIVE' || row.source_type !== 'EXTERNAL_MONITOR' || row.connection_mode !== 'EXTERNAL_MONITOR'
        || row.transition_state !== 'STABLE' || row.own_mid !== row.verified_account_mid || row.own_mid !== row.admin_binding_mid
        || row.admin_binding_mid !== row.current_admin_mid || Number(row.admin_binding_version) !== Number(row.current_admin_version)
        || row.product_role !== 'PRIMARY_ADMIN' || row.agent_role !== 'AGENT' || !row.read_capability) {
        throw new Error('External initial import reset authority is stale');
      }
      const checkpoint = await client.query<{ cursor: Record<string, unknown>; initial_import_complete: boolean }>(
        'SELECT cursor,initial_import_complete FROM external_source_checkpoints WHERE source_id=$1 AND account_id=$2 AND generation=$3 FOR UPDATE',
        [input.sourceId, input.accountId, input.generation]);
      const current = checkpoint.rows[0];
      if (!current || current.initial_import_complete || stableJson(current.cursor) !== stableJson(input.expectedCheckpoint)) {
        throw new Error('Completed or changed imports cannot be reset');
      }
      await client.query('DELETE FROM external_source_observations WHERE source_id=$1 AND generation=$2', [input.sourceId, input.generation]);
      await client.query('DELETE FROM external_source_conflicts WHERE source_id=$1 AND generation=$2', [input.sourceId, input.generation]);
      await client.query('DELETE FROM external_source_batches WHERE source_id=$1 AND generation=$2', [input.sourceId, input.generation]);
      await client.query(`UPDATE external_source_checkpoints SET cursor='{}'::jsonb,committed_count=0,high_water=$4::jsonb,
        eligible_count=$5,snapshot_digest=$6,import_schema_version=$7,initial_import_complete=false,updated_at=now()
        WHERE source_id=$1 AND account_id=$2 AND generation=$3`, [input.sourceId, input.accountId, input.generation,
        input.highWater === null ? null : stableJson(input.highWater), input.eligibleCount, input.snapshotDigest, input.schemaVersion]);
    });
  }

  async completeInitialImport(input: { accountId: string; sourceId: string; generation: number; expectedModeRevision: number;
    expectedCheckpoint: Record<string, unknown>; finalCursor: Record<string, unknown> | null; highWater: Record<string, unknown> | null;
    signal?: AbortSignal }): Promise<void> {
    return this.withImportOperation(input.signal, true, async (client) => {
      const authority = await client.query<{ mode_revision: string; state: string; connection_mode: string; transition_state: string;
        own_mid: string | null; verified_account_mid: string; admin_binding_mid: string | null; current_admin_mid: string | null;
        admin_binding_version: string | null; current_admin_version: string | null; product_role: string | null; agent_role: string | null;
        read_capability: boolean }>(`SELECT a.mode_revision,s.state,a.connection_mode,
        a.source_transition_state AS transition_state,a.own_mid,s.verified_account_mid,s.admin_binding_mid,
        admin.user_id AS current_admin_mid,s.admin_binding_version,av.version AS current_admin_version,a.product_role,
        agent.product_role AS agent_role,s.read_capability
        FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
          AND s.generation=a.selected_source_generation JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
        JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
        JOIN account_administrator_versions av ON av.account_id=agent.account_id
        WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 AND s.source_type='EXTERNAL_MONITOR'
        FOR UPDATE OF a,s,agent,admin,av`, [input.accountId, input.sourceId, input.generation]);
      const row = authority.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
      if (!row || row.state !== 'ACTIVE' || row.connection_mode !== 'EXTERNAL_MONITOR' || row.transition_state !== 'STABLE'
        || row.product_role !== 'PRIMARY_ADMIN' || row.agent_role !== 'AGENT' || !row.read_capability
        || Number(row.mode_revision) !== input.expectedModeRevision || row.own_mid !== row.verified_account_mid
        || row.own_mid !== row.admin_binding_mid || row.admin_binding_mid !== row.current_admin_mid
        || Number(row.admin_binding_version) !== Number(row.current_admin_version)) throw new Error('External initial import authority is stale');
      const checkpoint = await client.query<{ cursor: Record<string, unknown>; high_water: Record<string, unknown> | null;
        initial_import_complete: boolean; eligible_count: string | null; committed_count: string }>(`SELECT c.cursor,c.high_water,c.initial_import_complete,
        c.eligible_count,c.committed_count FROM external_source_checkpoints c
        WHERE c.source_id=$1 AND c.account_id=$2 AND c.generation=$3 FOR UPDATE`, [input.sourceId, input.accountId, input.generation]);
      const current = checkpoint.rows[0];
      if (!current || current.initial_import_complete || stableJson(current.cursor) !== stableJson(input.expectedCheckpoint)
        || stableJson(current.cursor) !== stableJson(input.finalCursor) || stableJson(current.high_water) !== stableJson(input.highWater)) {
        throw new Error('External initial import checkpoint is stale');
      }
      if (current.eligible_count !== null && BigInt(current.eligible_count) !== BigInt(current.committed_count)) {
        throw new Error('External initial import row count mismatch');
      }
      const pending = await client.query(`SELECT 1 FROM external_source_observations WHERE source_id=$1 AND generation=$2 AND status IN ('STAGED','CONFLICT') LIMIT 1`,
        [input.sourceId, input.generation]);
      if (pending.rowCount) throw new Error('External initial import has unprojected observations');
      await client.query(`UPDATE external_source_checkpoints SET initial_import_complete=true,updated_at=now()
        WHERE source_id=$1 AND account_id=$2 AND generation=$3 AND initial_import_complete=false`,
      [input.sourceId, input.accountId, input.generation]);
    }, false);
  }

  async stageAndProjectBatch(input: ExternalObservationBatch): Promise<ExternalBatchResult> {
    requiredText(input.accountId, 'account ID', 512);
    requiredText(input.sourceId, 'source ID', 64);
    requiredText(input.batchId, 'batch ID', 512);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid external source generation');
    if (!Number.isSafeInteger(input.expectedModeRevision) || input.expectedModeRevision < 0) throw new Error('Invalid external mode revision');
    if (!Array.isArray(input.observations) || input.observations.length > (input.initialImport === true ? MAX_INITIAL_IMPORT_OBSERVATIONS : MAX_OBSERVATIONS)) {
      throw new Error('External observation batch exceeds limit');
    }
    if (input.initialImport !== undefined && input.initialImport !== true) throw new Error('Invalid initial import page mode');
    if (!input.cursor || typeof input.cursor !== 'object' || Array.isArray(input.cursor)) throw new Error('Invalid external source cursor');
    const cursorJson = stableJson(input.cursor);
    if (Buffer.byteLength(cursorJson, 'utf8') > MAX_CURSOR_BYTES) throw new Error('External source cursor exceeds limit');
    if (input.expectedCheckpoint !== null && (!input.expectedCheckpoint || typeof input.expectedCheckpoint !== 'object'
      || Array.isArray(input.expectedCheckpoint))) throw new Error('Invalid external predecessor checkpoint');
    const expectedCheckpointJson = input.expectedCheckpoint === null ? null : stableJson(input.expectedCheckpoint);
    if (expectedCheckpointJson !== null && Buffer.byteLength(expectedCheckpointJson, 'utf8') > MAX_CURSOR_BYTES) {
      throw new Error('External predecessor checkpoint exceeds limit');
    }
    const observations = input.observations.map(normalizeObservation);
    if (input.initialImport && observations.some((observation) => observation.canonicalMessageId === null)) {
      throw new Error('External initial import page contains a row without a canonical message ID');
    }
    if (input.initialImport && new Set(observations.map((observation) => observation.observationId)).size !== observations.length) {
      throw new Error('External initial import page contains a duplicate observation');
    }
    if (input.tail && (!input.tail.marker || typeof input.tail.marker !== 'object'
      || Array.isArray(input.tail.marker))) throw new Error('Invalid external tail checkpoint');
    if (input.tail && input.expectedCheckpoint === null) throw new Error('External tail repair requires an existing checkpoint');
    if (input.tail && Buffer.byteLength(stableJson(input.tail), 'utf8') > MAX_CURSOR_BYTES) {
      throw new Error('External tail checkpoint exceeds limit');
    }
    if (input.tail && Buffer.byteLength(stableJson({ ...(input.expectedCheckpoint ?? {}), tail: input.tail.marker }), 'utf8') > MAX_CURSOR_BYTES) {
      throw new Error('External checkpoint exceeds limit');
    }
    const payloadJson = stableJson({ expectedModeRevision: input.expectedModeRevision, expectedCheckpoint: input.expectedCheckpoint,
      initialImport: input.initialImport === true,
      cursor: input.cursor, tail: input.tail ?? null, observations });
    const batchLimit = input.initialImport === true ? MAX_INITIAL_IMPORT_BATCH_BYTES : MAX_BATCH_BYTES;
    if (Buffer.byteLength(payloadJson, 'utf8') > batchLimit) throw new Error('External observation batch exceeds limit');
    const payloadDigest = digest(payloadJson);
    return this.withImportOperation(input.signal, true, async (client) => {
      const binding = await client.query<{ own_mid: string | null; verified_account_mid: string; identity_digest: string; state: string;
        product_role: string | null; source_transition_state: string; connection_mode: string; mode_revision: string;
        admin_binding_account_id: string | null; admin_binding_mid: string | null; admin_binding_version: string | null;
        agent_role: string | null; current_admin_mid: string | null; current_admin_version: string | null }>(
        `SELECT a.own_mid,s.verified_account_mid,s.identity_digest,s.state,a.product_role,a.source_transition_state,
          a.connection_mode,a.mode_revision,s.admin_binding_account_id,s.admin_binding_mid,s.admin_binding_version,
          agent.product_role AS agent_role,admin.user_id AS current_admin_mid,av.version AS current_admin_version
         FROM line_accounts a JOIN line_account_sources s
          ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
         JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
         JOIN account_administrator_versions av ON av.account_id=agent.account_id
         WHERE a.account_id=$1 AND a.connection_mode='EXTERNAL_MONITOR' AND s.source_id=$2 AND s.generation=$3
          AND s.source_type='EXTERNAL_MONITOR' AND s.read_capability=true FOR UPDATE OF a,s,agent,admin,av`,
        [input.accountId, input.sourceId, input.generation]);
      const boundRow = binding.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
      if (!boundRow || boundRow.state !== 'ACTIVE' || boundRow.own_mid !== boundRow.verified_account_mid) {
        throw new Error('External source generation is stale');
      }
      const authority = boundRow;
      if (authority.product_role !== 'PRIMARY_ADMIN' || authority.source_transition_state !== 'STABLE'
        || authority.connection_mode !== 'EXTERNAL_MONITOR' || Number(authority.mode_revision) !== input.expectedModeRevision) {
        throw new Error('External source authority is stale');
      }
      if (!authority.admin_binding_account_id || !authority.admin_binding_mid || !authority.admin_binding_version
        || authority.agent_role !== 'AGENT' || authority.current_admin_mid !== authority.admin_binding_mid
        || Number(authority.current_admin_version) !== Number(authority.admin_binding_version)
        || authority.admin_binding_mid !== authority.own_mid) {
        throw new Error('External administrator binding is stale');
      }
      const priorBatch = await client.query<{ payload_digest: string; result: ExternalBatchResult }>(
        'SELECT payload_digest,result FROM external_source_batches WHERE source_id=$1 AND generation=$2 AND batch_id=$3 FOR UPDATE',
        [input.sourceId, input.generation, input.batchId]);
      if (priorBatch.rows[0]) {
        if (priorBatch.rows[0].payload_digest !== payloadDigest) throw new Error('External batch replay digest mismatch');
        return { ...priorBatch.rows[0].result, changedMessages: priorBatch.rows[0].result.changedMessages ?? [], replayed: true };
      }
      const checkpoint = await client.query<{ account_id: string; generation: string; cursor: Record<string, unknown> }>(
        'SELECT account_id,generation,cursor FROM external_source_checkpoints WHERE source_id=$1 FOR UPDATE', [input.sourceId]);
      const checkpointRow = checkpoint.rows[0];
      if (input.expectedCheckpoint === null ? checkpointRow !== undefined
        : !checkpointRow || checkpointRow.account_id !== input.accountId || Number(checkpointRow.generation) !== input.generation
          || stableJson(checkpointRow.cursor) !== expectedCheckpointJson) {
        throw new Error('External predecessor checkpoint mismatch');
      }
      if (input.initialImport) {
        const status = await client.query<{ initial_import_complete: boolean }>(
          'SELECT initial_import_complete FROM external_source_checkpoints WHERE source_id=$1', [input.sourceId]);
        if (!status.rows[0] || status.rows[0].initial_import_complete) throw new Error('External initial import is no longer active');
      }
      let committedCursor = input.cursor;
      if (input.tail) committedCursor = { ...(input.expectedCheckpoint ?? {}), tail: input.tail.marker };
      await client.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
        VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`, [input.sourceId, input.accountId, input.generation, input.batchId, payloadDigest]);

      let projected = 0;
      let newlyProjected = 0;
      let conflicts = 0;
      const changedMessages: ExternalChangedMessage[] = [];
      if (input.initialImport && !input.tail && observations.length > 0 && supportsInitialPageBulkWrite(observations)) {
        const bulk = await projectInitialPageBulk(client, input, observations);
        projected = bulk.projected;
        newlyProjected = bulk.newlyProjected;
        changedMessages.push(...bulk.changedMessages);
      } else {
        const nameCandidates: ExternalObservation[] = [];
        for (const observation of observations) {
        const normalizedJson = stableJson(observation);
        const normalizedDigest = canonicalDigest(observation);
        const staged = await client.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,
          canonical_message_id,normalized_digest,normalized_payload,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'STAGED')
          ON CONFLICT (source_id,generation,observation_id) DO NOTHING RETURNING observation_id`,
        [input.sourceId, input.accountId, input.generation, observation.observationId, input.batchId, observation.canonicalMessageId,
          normalizedDigest, normalizedJson]);
        if (!staged.rowCount) {
          const existing = await client.query<{ normalized_digest: string; status: string; normalized_payload: ExternalObservation;
            canonical_message_id: string | null;
            raw_native_payload: unknown }>(
            `SELECT o.normalized_digest,o.status,o.normalized_payload,o.canonical_message_id,m.raw->'native' AS raw_native_payload
             FROM external_source_observations o LEFT JOIN messages m
              ON m.account_id=o.account_id AND m.message_id=o.canonical_message_id
             WHERE o.source_id=$1 AND o.generation=$2 AND o.observation_id=$3 FOR UPDATE OF o`,
            [input.sourceId, input.generation, observation.observationId]);
          const prior = existing.rows[0];
          const effectiveObservation = mergeStoredNativeFields(observation, prior?.normalized_payload, prior?.raw_native_payload);
          const effectiveJson = stableJson(effectiveObservation);
          const effectiveDigest = canonicalDigest(effectiveObservation);
          const nativeIdentityMatches = prior?.status === 'PROJECTED'
            && prior.canonical_message_id === effectiveObservation.canonicalMessageId
            && Boolean(prior.normalized_payload?.nativePayload || effectiveObservation.nativePayload);
          if (prior?.normalized_digest !== effectiveDigest && nativeIdentityMatches) {
            await client.query(`UPDATE external_source_observations SET batch_id=$4,canonical_message_id=$5,
              normalized_digest=$6,normalized_payload=$7::jsonb,conflict_reason=NULL
              WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
            [input.sourceId, input.generation, observation.observationId, input.batchId, effectiveObservation.canonicalMessageId,
              effectiveDigest, effectiveJson]);
            nameCandidates.push(effectiveObservation);
            if (await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, effectiveObservation)) {
              changedMessages.push({ chatType: effectiveObservation.chatType, chatId: effectiveObservation.chatId,
                messageId: effectiveObservation.canonicalMessageId! });
            }
            projected++;
          } else if (prior?.normalized_digest !== effectiveDigest) {
            await client.query(`INSERT INTO external_source_conflicts(source_id,account_id,generation,observation_id,batch_id,
              canonical_message_id,normalized_digest,normalized_payload,conflict_reason)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'SOURCE_ID_REUSED_WITH_CHANGED_DIGEST') ON CONFLICT DO NOTHING`,
            [input.sourceId, input.accountId, input.generation, observation.observationId, input.batchId,
              effectiveObservation.canonicalMessageId, effectiveDigest, effectiveJson]);
            conflicts++;
          } else if (prior?.status === 'CONFLICT') conflicts++;
          else if (input.initialImport && prior?.status !== 'PROJECTED') throw new Error('External initial import found a staged observation');
          else if (prior?.status === 'PROJECTED') {
            if (nativeFieldsDiffer(prior.normalized_payload, effectiveObservation)) {
              await client.query(`UPDATE external_source_observations SET batch_id=$4,normalized_payload=$5::jsonb
                WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
              [input.sourceId, input.generation, observation.observationId, input.batchId, effectiveJson]);
            }
            if (input.tail && prior.normalized_digest === effectiveDigest) {
              const repair = await this.repairProjectedObservation(client, input, effectiveObservation);
              if (repair.status === 'CONFLICT') {
                await client.query(`INSERT INTO external_source_conflicts(source_id,account_id,generation,observation_id,batch_id,
                  canonical_message_id,normalized_digest,normalized_payload,conflict_reason)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'CANONICAL_ARCHIVE_MISMATCH') ON CONFLICT DO NOTHING`,
                [input.sourceId, input.accountId, input.generation, effectiveObservation.observationId, input.batchId,
                  effectiveObservation.canonicalMessageId, effectiveDigest, effectiveJson]);
                conflicts++;
              }
              else {
                nameCandidates.push(effectiveObservation);
                if (repair.changed) changedMessages.push({ chatType: effectiveObservation.chatType, chatId: effectiveObservation.chatId,
                  messageId: effectiveObservation.canonicalMessageId! });
                projected++;
              }
            } else {
              nameCandidates.push(effectiveObservation);
              if (effectiveObservation.nativePayload || effectiveObservation.nativeStickerMetadata) {
                if (await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, effectiveObservation)) {
                  changedMessages.push({ chatType: effectiveObservation.chatType, chatId: effectiveObservation.chatId,
                    messageId: effectiveObservation.canonicalMessageId! });
                }
              }
              projected++;
            }
          }
          continue;
        }
        if (!observation.canonicalMessageId) continue;
        nameCandidates.push(observation);
        const changed = await projectStagedSourceObservation(client, { accountId: input.accountId, sourceId: input.sourceId,
          generation: input.generation, observation, origin: 'EXTERNAL_MONITOR' });
        if (changed && observation.canonicalMessageId) changedMessages.push({ chatType: observation.chatType, chatId: observation.chatId, messageId: observation.canonicalMessageId });
        projected++;
        newlyProjected++;
      }
        const updatedNames = await upsertCommunityMemberNames(client, input.accountId, nameCandidates);
        addNameChangedMessages(changedMessages, nameCandidates, updatedNames);
        addUniqueChangedMessages(changedMessages, await updateExternalMentionRanges(client, input.accountId, nameCandidates));
      }
      if (input.initialImport && conflicts > 0) throw new Error('External initial import page contains a conflict');
      const result: ExternalBatchResult = { staged: observations.length, projected, conflicts, replayed: false, changedMessages };
      await client.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor,committed_count,updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,now()) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation,
          cursor=EXCLUDED.cursor,committed_count=external_source_checkpoints.committed_count+$5,updated_at=now()`,
      [input.sourceId, input.accountId, input.generation, stableJson(committedCursor), input.initialImport ? newlyProjected : 0]);
      await client.query('UPDATE external_source_batches SET result=$4::jsonb WHERE source_id=$1 AND generation=$2 AND batch_id=$3',
        [input.sourceId, input.generation, input.batchId, JSON.stringify(result)]);
      return result;
    });
  }

  /** Commits one bounded native catalog page without moving message progress. */
  async storeNativeCatalogPage(input: { accountId: string; sourceId: string; generation: number; expectedModeRevision: number;
    expectedCheckpoint: Record<string, unknown> | null; snapshotDigest: string; batchId: string;
    records: readonly NativeCatalogRecord[]; signal?: AbortSignal }): Promise<NativeCatalogPageResult> {
    requiredText(input.accountId, 'account ID', 512);
    requiredText(input.sourceId, 'source ID', 64);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid external source generation');
    if (!Number.isSafeInteger(input.expectedModeRevision) || input.expectedModeRevision < 0) throw new Error('Invalid external mode revision');
    if (!/^[a-f0-9]{64}$/.test(input.snapshotDigest)) throw new Error('Invalid external snapshot digest');
    if (!input.batchId.startsWith('catalog:')) throw new Error('Native catalog batch ID must use the catalog prefix');
    requiredText(input.batchId, 'catalog batch ID', 512);
    if (!Array.isArray(input.records) || input.records.length > MAX_NATIVE_CATALOG_RECORDS) throw new Error('Native catalog page exceeds record limit');
    if (input.expectedCheckpoint !== null && (!isPlainRecord(input.expectedCheckpoint)
      || Buffer.byteLength(stableJson(input.expectedCheckpoint), 'utf8') > MAX_CURSOR_BYTES)) {
      throw new Error('Invalid external predecessor checkpoint');
    }
    const parsedRecords = input.records.map((record) => NativeCatalogRecordSchema.parse(record));
    const uniqueRecords = new Map<string, NativeCatalogRecord>();
    for (const record of parsedRecords) {
      const key = stableJson([record.tableName, record.recordKey]);
      const prior = uniqueRecords.get(key);
      if (prior && prior.nativePayload.sourceDigest !== record.nativePayload.sourceDigest) {
        throw new Error('Native catalog page contains a duplicate key with different source data');
      }
      if (!prior) uniqueRecords.set(key, record);
    }
    const records = [...uniqueRecords.values()];
    const payloadJson = stableJson({ expectedModeRevision: input.expectedModeRevision, expectedCheckpoint: input.expectedCheckpoint,
      snapshotDigest: input.snapshotDigest, records: parsedRecords });
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_NATIVE_CATALOG_PAGE_BYTES) throw new Error('Native catalog page exceeds byte limit');
    const payloadDigest = digest(payloadJson);
    return this.withImportOperation(input.signal, true, async (client) => {
      const authority = await client.query<{ mode_revision: string; identity_digest: string; state: string; source_type: string;
        connection_mode: string; transition_state: string; own_mid: string | null; verified_account_mid: string;
        admin_binding_mid: string | null; current_admin_mid: string | null; admin_binding_version: string | null;
        current_admin_version: string | null; product_role: string | null; agent_role: string | null; read_capability: boolean }>(
        `SELECT a.mode_revision,s.identity_digest,s.state,s.source_type,a.connection_mode,a.source_transition_state AS transition_state,
          a.own_mid,s.verified_account_mid,s.admin_binding_mid,admin.user_id AS current_admin_mid,
          s.admin_binding_version,av.version AS current_admin_version,a.product_role,agent.product_role AS agent_role,s.read_capability
         FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
          AND s.generation=a.selected_source_generation JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
         JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
         JOIN account_administrator_versions av ON av.account_id=agent.account_id
         WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 AND s.source_type='EXTERNAL_MONITOR'
         FOR UPDATE OF a,s,agent,admin,av`, [input.accountId, input.sourceId, input.generation]);
      const row = authority.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
      if (!row || Number(row.mode_revision) !== input.expectedModeRevision || row.state !== 'ACTIVE'
        || row.source_type !== 'EXTERNAL_MONITOR' || row.connection_mode !== 'EXTERNAL_MONITOR' || row.transition_state !== 'STABLE'
        || row.own_mid !== row.verified_account_mid || row.own_mid !== row.admin_binding_mid || row.admin_binding_mid !== row.current_admin_mid
        || Number(row.admin_binding_version) !== Number(row.current_admin_version) || row.product_role !== 'PRIMARY_ADMIN'
        || row.agent_role !== 'AGENT' || !row.read_capability) throw new Error('External source authority is stale');
      const prior = await client.query<{ payload_digest: string; result: NativeCatalogPageResult }>(
        'SELECT payload_digest,result FROM external_source_batches WHERE source_id=$1 AND generation=$2 AND batch_id=$3 FOR UPDATE',
        [input.sourceId, input.generation, input.batchId]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_digest !== payloadDigest) throw new Error('External batch replay digest mismatch');
        return { ...prior.rows[0].result, replayed: true };
      }
      const checkpoint = await client.query<{ account_id: string; generation: string; cursor: Record<string, unknown>;
        snapshot_digest: string | null }>(
        'SELECT account_id,generation,cursor,snapshot_digest FROM external_source_checkpoints WHERE source_id=$1 FOR UPDATE', [input.sourceId]);
      const current = checkpoint.rows[0];
      if (!current || current.account_id !== input.accountId || Number(current.generation) !== input.generation
        || stableJson(current.cursor) !== stableJson(input.expectedCheckpoint) || current.snapshot_digest !== input.snapshotDigest) {
        throw new Error('External predecessor checkpoint mismatch');
      }
      await client.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
        VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`, [input.sourceId, input.accountId, input.generation, input.batchId, payloadDigest]);
      const upserted = records.length === 0 ? { rowCount: 0 } : await client.query(`INSERT INTO native_source_catalog_records(
          account_id,source_id,generation,table_name,record_key,source_digest,native_payload)
        SELECT $1,$2,$3,row.table_name,row.record_key,row.source_digest,row.native_payload
          FROM jsonb_to_recordset($4::jsonb) AS row(table_name text,record_key text,source_digest text,native_payload jsonb)
        ON CONFLICT(source_id,generation,table_name,record_key) DO UPDATE SET
          source_digest=EXCLUDED.source_digest,native_payload=EXCLUDED.native_payload,updated_at=now()
        WHERE native_source_catalog_records.source_digest IS DISTINCT FROM EXCLUDED.source_digest
        RETURNING record_key`, [input.accountId, input.sourceId, input.generation, JSON.stringify(records.map((record) => ({
        table_name: record.tableName, record_key: record.recordKey,
        source_digest: record.nativePayload.sourceDigest, native_payload: record.nativePayload,
      })))]);
      const result: NativeCatalogPageResult = { stored: records.length, changed: upserted.rowCount ?? 0, replayed: false };
      await client.query('UPDATE external_source_batches SET result=$4::jsonb WHERE source_id=$1 AND generation=$2 AND batch_id=$3',
        [input.sourceId, input.generation, input.batchId, JSON.stringify(result)]);
      return result;
    });
  }

  /**
   * Commits one bounded native directory page (friend names and computed conversation titles) in a
   * single transaction. Idempotent upserts keyed by account; it never moves message progress. A
   * computed title overwrites a stale one, but an empty computed title never blanks an existing title.
   */
  async storeNativeDirectoryPage(input: { accountId: string; sourceId: string; generation: number; expectedModeRevision: number;
    rows: readonly NativeDirectoryRow[]; signal?: AbortSignal }): Promise<NativeDirectoryPageResult> {
    requiredText(input.accountId, 'account ID', 512);
    requiredText(input.sourceId, 'source ID', 64);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid external source generation');
    if (!Number.isSafeInteger(input.expectedModeRevision) || input.expectedModeRevision < 0) throw new Error('Invalid external mode revision');
    if (!Array.isArray(input.rows) || input.rows.length > MAX_NATIVE_DIRECTORY_ROWS) throw new Error('Native directory page exceeds row limit');
    const rows = input.rows.map((row) => NativeDirectoryRowSchema.parse(row));
    const contacts = rows.flatMap((row) => row.kind === 'contact'
      ? [{ mid: row.mid, displayName: row.displayName, nickname: row.nickname,
        ...(row.picturePath === undefined ? {} : { picturePath: row.picturePath }), nativeType: row.type, nativeStatus: row.status }] : []);
    const contactPictures = new Map(contacts.map((contact) => [contact.mid, normalizeNativePicturePath(contact.picturePath)]));
    const conversations = new Map<string, { chat_type: string; chat_id: string; title: string | null; picture_path: string | null; native_metadata: NativeConversationMetadata }>();
    for (const row of rows) {
      if (row.kind !== 'conversation') continue;
      conversations.set(stableJson([row.chatType, row.chatId]), { chat_type: row.chatType, chat_id: row.chatId,
        title: row.title, picture_path: row.chatType === 'direct' ? contactPictures.get(row.chatId) ?? null : normalizeNativePicturePath(row.picturePath),
        native_metadata: NativeConversationMetadataSchema.parse(row.nativeMetadata) });
    }
    const conversationRows = [...conversations.values()];
    return this.withImportOperation(input.signal, true, async (client) => {
      await assertExternalSourceAuthority(client, input);
      const contactsChanged = await upsertLineContacts(client, input.accountId, contacts);
      const directPeerIds = [...new Set(conversationRows.filter((row) => row.chat_type === 'direct').map((row) => row.chat_id))];
      const persistedPictures = new Map<string, string | null>();
      if (directPeerIds.length > 0) {
        const persisted = await client.query<{ mid: string; picture_path: string | null }>(
          'SELECT mid,picture_path FROM line_contacts WHERE account_id=$1 AND mid=ANY($2::text[])', [input.accountId, directPeerIds]);
        for (const contact of persisted.rows) persistedPictures.set(contact.mid, contact.picture_path);
      }
      for (const row of conversationRows) {
        if (row.chat_type !== 'direct') continue;
        row.picture_path = contactPictures.get(row.chat_id) ?? persistedPictures.get(row.chat_id) ?? null;
      }
      let conversationsChanged = 0;
      if (conversationRows.length > 0) {
        const payload = JSON.stringify(conversationRows);
        const inserted = await client.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,native_metadata,picture_path)
          SELECT $1,row.chat_type,row.chat_id,COALESCE(row.title,''),row.native_metadata,row.picture_path
            FROM jsonb_to_recordset($2::jsonb) AS row(chat_type text,chat_id text,title text,picture_path text,native_metadata jsonb)
          ON CONFLICT(account_id,chat_type,chat_id) DO NOTHING`, [input.accountId, payload]);
        const updated = await client.query(`UPDATE conversations AS conversation SET
            title=COALESCE(supplied.title,conversation.title),native_metadata=supplied.native_metadata,
            picture_path=COALESCE(supplied.picture_path,conversation.picture_path),updated_at=now()
          FROM jsonb_to_recordset($2::jsonb) AS supplied(chat_type text,chat_id text,title text,picture_path text,native_metadata jsonb)
          WHERE conversation.account_id=$1 AND conversation.chat_type=supplied.chat_type AND conversation.chat_id=supplied.chat_id
            AND ((supplied.title IS NOT NULL AND conversation.title IS DISTINCT FROM supplied.title)
              OR conversation.native_metadata IS DISTINCT FROM supplied.native_metadata
              OR conversation.picture_path IS DISTINCT FROM COALESCE(supplied.picture_path,conversation.picture_path))`, [input.accountId, payload]);
        conversationsChanged = (inserted.rowCount ?? 0) + (updated.rowCount ?? 0);
      }
      return { contacts: contacts.length, contactsChanged, conversationsChanged };
    });
  }

  /** Commits one live forward page and its bounded tail reconciliation atomically. */
  async commitDirectPoll(input: ExternalDirectPollInput): Promise<ExternalDirectPollResult> {
    requiredText(input.accountId, 'account ID', 512);
    requiredText(input.sourceId, 'source ID', 64);
    requiredText(input.batchId, 'batch ID', 512);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Invalid external source generation');
    if (!Number.isSafeInteger(input.expectedModeRevision) || input.expectedModeRevision < 0) throw new Error('Invalid external mode revision');
    if (!input.cursor || typeof input.cursor !== 'object' || Array.isArray(input.cursor)
      || Buffer.byteLength(stableJson(input.cursor), 'utf8') > MAX_CURSOR_BYTES) throw new Error('Invalid external source cursor');
    if (input.expectedCheckpoint !== null && (!input.expectedCheckpoint || typeof input.expectedCheckpoint !== 'object'
      || Array.isArray(input.expectedCheckpoint) || Buffer.byteLength(stableJson(input.expectedCheckpoint), 'utf8') > MAX_CURSOR_BYTES)) {
      throw new Error('Invalid external predecessor checkpoint');
    }
    if (!Array.isArray(input.forwardObservations) || input.forwardObservations.length > MAX_OBSERVATIONS) {
      throw new Error('External forward page exceeds limit');
    }
    if (!Array.isArray(input.tailObservations) || input.tailObservations.length > 50) throw new Error('External live tail exceeds limit');
    const tailWindow = input.tailWindow === undefined ? undefined : normalizeTailWindow(input.tailWindow);
    const forward = input.forwardObservations.map(normalizeObservation);
    const tail = input.tailObservations.map(normalizeObservation);
    if (forward.some((row) => row.canonicalMessageId === null) || tail.some((row) => row.canonicalMessageId === null)) {
      throw new Error('External direct poll contains a row without a canonical message ID');
    }
    if (new Set(forward.map((row) => row.observationId)).size !== forward.length
      || new Set(tail.map((row) => row.observationId)).size !== tail.length) throw new Error('External direct poll contains duplicate observations');
    const unreadEntries = normalizeUnreadCounts(input.unreadCounts);
    const expectedCheckpointJson = input.expectedCheckpoint === null ? null : stableJson(input.expectedCheckpoint);
    const payloadJson = stableJson({ expectedModeRevision: input.expectedModeRevision, expectedCheckpoint: input.expectedCheckpoint,
      cursor: input.cursor, forwardObservations: forward, tailObservations: tail,
      ...(tailWindow === undefined ? {} : { tailWindow }),
      ...(unreadEntries === undefined ? {} : { unreadCounts: unreadEntries }) });
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_BATCH_BYTES) throw new Error('External observation batch exceeds limit');
    const payloadDigest = digest(payloadJson);

    return this.withImportOperation(input.signal, true, async (client) => {
      const binding = await client.query<{ own_mid: string | null; verified_account_mid: string; state: string;
        product_role: string | null; source_transition_state: string; connection_mode: string; mode_revision: string;
        admin_binding_account_id: string | null; admin_binding_mid: string | null; admin_binding_version: string | null;
        agent_role: string | null; current_admin_mid: string | null; current_admin_version: string | null }>(
        `SELECT a.own_mid,s.verified_account_mid,s.state,a.product_role,a.source_transition_state,a.connection_mode,a.mode_revision,
          s.admin_binding_account_id,s.admin_binding_mid,s.admin_binding_version,agent.product_role AS agent_role,
          admin.user_id AS current_admin_mid,av.version AS current_admin_version
         FROM line_accounts a JOIN line_account_sources s
          ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
         JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
         JOIN account_administrator_versions av ON av.account_id=agent.account_id
         WHERE a.account_id=$1 AND a.connection_mode='EXTERNAL_MONITOR' AND s.source_id=$2 AND s.generation=$3
          AND s.source_type='EXTERNAL_MONITOR' AND s.read_capability=true FOR UPDATE OF a,s,agent,admin,av`,
        [input.accountId, input.sourceId, input.generation]);
      const authority = binding.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
      if (!authority || authority.state !== 'ACTIVE' || authority.own_mid !== authority.verified_account_mid) throw new Error('External source generation is stale');
      if (authority.product_role !== 'PRIMARY_ADMIN' || authority.source_transition_state !== 'STABLE'
        || authority.connection_mode !== 'EXTERNAL_MONITOR' || Number(authority.mode_revision) !== input.expectedModeRevision) {
        throw new Error('External source authority is stale');
      }
      if (!authority.admin_binding_account_id || !authority.admin_binding_mid || !authority.admin_binding_version
        || authority.agent_role !== 'AGENT' || authority.current_admin_mid !== authority.admin_binding_mid
        || Number(authority.current_admin_version) !== Number(authority.admin_binding_version)
        || authority.admin_binding_mid !== authority.own_mid) throw new Error('External administrator binding is stale');

      const priorBatch = await client.query<{ payload_digest: string; result: ExternalDirectPollResult }>(
        'SELECT payload_digest,result FROM external_source_batches WHERE source_id=$1 AND generation=$2 AND batch_id=$3 FOR UPDATE',
        [input.sourceId, input.generation, input.batchId]);
      if (priorBatch.rows[0]) {
        if (priorBatch.rows[0].payload_digest !== payloadDigest) throw new Error('External batch replay digest mismatch');
        return { ...priorBatch.rows[0].result, changedMessages: [], unreadChanged: 0, replayed: true };
      }

      const checkpoint = await client.query<{ account_id: string; generation: string; cursor: Record<string, unknown> }>(
        'SELECT account_id,generation,cursor FROM external_source_checkpoints WHERE source_id=$1 FOR UPDATE', [input.sourceId]);
      const checkpointRow = checkpoint.rows[0];
      if (input.expectedCheckpoint === null ? checkpointRow !== undefined
        : !checkpointRow || checkpointRow.account_id !== input.accountId || Number(checkpointRow.generation) !== input.generation
          || stableJson(checkpointRow.cursor) !== expectedCheckpointJson) throw new Error('External predecessor checkpoint mismatch');

      const changed = new Map<string, ExternalChangedMessage>();
      let projected = 0;
      let conflicts = 0;
      let tailRepaired = 0;
      let receiptWritten = false;
      const ensureBatchReceipt = async () => {
        if (receiptWritten) return;
        await client.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
          VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`, [input.sourceId, input.accountId, input.generation, input.batchId, payloadDigest]);
        receiptWritten = true;
      };
      const rememberChanged = (row: ExternalObservation) => {
        if (row.canonicalMessageId) changed.set(stableJson([row.chatType, row.chatId, row.canonicalMessageId]),
          { chatType: row.chatType, chatId: row.chatId, messageId: row.canonicalMessageId });
      };

      const nameCandidates: ExternalObservation[] = [];
      if (forward.length) {
        await ensureBatchReceipt();
        for (const incomingObservation of forward) {
          let observation = incomingObservation;
          let normalizedJson = stableJson(observation);
          let normalizedDigest = canonicalDigest(observation);
          const staged = await client.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,
            canonical_message_id,normalized_digest,normalized_payload,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'STAGED')
            ON CONFLICT (source_id,generation,observation_id) DO NOTHING RETURNING observation_id`,
          [input.sourceId, input.accountId, input.generation, observation.observationId, input.batchId, observation.canonicalMessageId,
            normalizedDigest, normalizedJson]);
          if (!staged.rowCount) {
            const existing = await client.query<{ batch_id: string; normalized_digest: string; status: string;
              normalized_payload: ExternalObservation; canonical_message_id: string | null; raw_native_payload: unknown }>(
              `SELECT o.batch_id,o.normalized_digest,o.status,o.normalized_payload,o.canonical_message_id,m.raw->'native' AS raw_native_payload
               FROM external_source_observations o LEFT JOIN messages m
                ON m.account_id=o.account_id AND m.message_id=o.canonical_message_id
               WHERE o.source_id=$1 AND o.generation=$2 AND o.observation_id=$3 FOR UPDATE OF o`,
              [input.sourceId, input.generation, observation.observationId]);
            const row = existing.rows[0];
            observation = mergeStoredNativeFields(incomingObservation, row?.normalized_payload, row?.raw_native_payload);
            normalizedJson = stableJson(observation);
            normalizedDigest = canonicalDigest(observation);
            if (row?.normalized_digest !== normalizedDigest && row?.status === 'PROJECTED'
              && row.canonical_message_id === observation.canonicalMessageId) {
              await client.query(`UPDATE external_source_observations SET batch_id=$4,canonical_message_id=$5,
                normalized_digest=$6,normalized_payload=$7::jsonb,conflict_reason=NULL
                WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
              [input.sourceId, input.generation, observation.observationId, input.batchId, observation.canonicalMessageId, normalizedDigest, normalizedJson]);
              nameCandidates.push(observation);
              if (await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, observation)) rememberChanged(observation);
              await client.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
                VALUES ($1,$2,$3,$4,$5,'EXTERNAL_MONITOR',true) ON CONFLICT DO NOTHING`,
              [input.accountId, observation.canonicalMessageId, input.sourceId, input.generation, observation.observationId]);
              projected++;
              continue;
            }
            if (row?.normalized_digest !== normalizedDigest) {
              await client.query(`INSERT INTO external_source_conflicts(source_id,account_id,generation,observation_id,batch_id,
                canonical_message_id,normalized_digest,normalized_payload,conflict_reason)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'SOURCE_ID_REUSED_WITH_CHANGED_DIGEST') ON CONFLICT DO NOTHING`,
              [input.sourceId, input.accountId, input.generation, observation.observationId, input.batchId,
                observation.canonicalMessageId, normalizedDigest, normalizedJson]);
              conflicts++;
              continue;
            }
            if (row?.status === 'CONFLICT') { conflicts++; continue; }
            if (row?.status === 'PROJECTED' && nativeFieldsDiffer(row.normalized_payload, observation)) {
              await client.query(`UPDATE external_source_observations SET batch_id=$4,normalized_payload=$5::jsonb
                WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
              [input.sourceId, input.generation, observation.observationId, input.batchId, normalizedJson]);
            }
          }
          nameCandidates.push(observation);
          if (await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, observation)) rememberChanged(observation);
          await client.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
            VALUES ($1,$2,$3,$4,$5,'EXTERNAL_MONITOR',true) ON CONFLICT DO NOTHING`,
          [input.accountId, observation.canonicalMessageId, input.sourceId, input.generation, observation.observationId]);
          await client.query(`UPDATE external_source_observations SET status='PROJECTED'
            WHERE source_id=$1 AND generation=$2 AND observation_id=$3`, [input.sourceId, input.generation, observation.observationId]);
          projected++;
        }
        await client.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor,committed_count,updated_at)
          VALUES ($1,$2,$3,$4::jsonb,0,now()) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation,
            cursor=EXCLUDED.cursor,updated_at=now()`,
        [input.sourceId, input.accountId, input.generation, stableJson(input.cursor)]);
      }

      for (const incomingObservation of tail) {
        const existing = await client.query<{ batch_id: string; canonical_message_id: string | null;
          normalized_digest: string; status: string; normalized_payload: ExternalObservation; raw_native_payload: unknown }>(
          `SELECT o.batch_id,o.canonical_message_id,o.normalized_digest,o.status,o.normalized_payload,m.raw->'native' AS raw_native_payload
           FROM external_source_observations o LEFT JOIN messages m
            ON m.account_id=o.account_id AND m.message_id=o.canonical_message_id
           WHERE o.source_id=$1 AND o.generation=$2 AND o.observation_id=$3 FOR UPDATE OF o`,
          [input.sourceId, input.generation, incomingObservation.observationId]);
        const row = existing.rows[0];
        const observation = mergeStoredNativeFields(incomingObservation, row?.normalized_payload, row?.raw_native_payload);
        if (row && row.canonical_message_id !== observation.canonicalMessageId) {
          throw new Error('External live tail observation identity mismatch');
        }
        if (row?.status === 'CONFLICT') throw new Error('External live tail observation is in conflict');
        const provenance = await client.query<{ message_id: string }>(
          'SELECT message_id FROM message_source_provenance WHERE source_id=$1 AND generation=$2 AND observation_id=$3 FOR UPDATE',
          [input.sourceId, input.generation, observation.observationId]);
        if (provenance.rows[0] && provenance.rows[0].message_id !== observation.canonicalMessageId) throw new Error('External live tail provenance identity mismatch');
        const normalizedDigest = canonicalDigest(observation);
        const canonicalMatches = await canonicalLineMessageMatches(client, input.accountId, observation);
        const needsProjection = !row || row.status !== 'PROJECTED' || row.normalized_digest !== normalizedDigest
          || !canonicalMatches || !provenance.rows[0] || nativeFieldsDiffer(row.normalized_payload, observation);
        if (needsProjection) await ensureBatchReceipt();
        if (!row) {
          await client.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,
            canonical_message_id,normalized_digest,normalized_payload,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'STAGED')`,
          [input.sourceId, input.accountId, input.generation, observation.observationId, input.batchId,
            observation.canonicalMessageId, normalizedDigest, stableJson(observation)]);
        } else if (needsProjection) {
          await client.query(`UPDATE external_source_observations SET batch_id=$4,canonical_message_id=$5,
            normalized_digest=$6,normalized_payload=$7::jsonb,status='STAGED',conflict_reason=NULL
            WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
          [input.sourceId, input.generation, observation.observationId, input.batchId,
            observation.canonicalMessageId, normalizedDigest, stableJson(observation)]);
        }
        nameCandidates.push(observation);
        const wasChanged = await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, observation);
        if (!provenance.rows[0]) await client.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
          VALUES ($1,$2,$3,$4,$5,'EXTERNAL_MONITOR',true) ON CONFLICT DO NOTHING`,
        [input.accountId, observation.canonicalMessageId, input.sourceId, input.generation, observation.observationId]);
        if (needsProjection) await client.query(`UPDATE external_source_observations
          SET status='PROJECTED' WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
        [input.sourceId, input.generation, observation.observationId]);
        if (needsProjection) tailRepaired++;
        if (wasChanged) rememberChanged(observation);
      }

      if (tailWindow !== undefined) {
        const marks = await reconcileSourceDeletions(client, input, tailWindow, tail, forward);
        if (marks.length > 0) await ensureBatchReceipt();
        for (const row of marks) changed.set(stableJson([row.chatType, row.chatId, row.messageId]), row);
      }

      const updatedNames = await upsertCommunityMemberNames(client, input.accountId, nameCandidates);
      const updatedMentions = await updateExternalMentionRanges(client, input.accountId, nameCandidates);
      if (updatedNames.size > 0 && !receiptWritten) await ensureBatchReceipt();
      if (updatedMentions.length > 0 && !receiptWritten) await ensureBatchReceipt();
      for (const observation of nameCandidates) {
        const memberKey = communityMemberKey(observation);
        if (!observation.canonicalMessageId || memberKey === null || !updatedNames.has(memberKey)) continue;
        changed.set(stableJson([observation.chatType, observation.chatId, observation.canonicalMessageId]), {
          chatType: observation.chatType, chatId: observation.chatId, messageId: observation.canonicalMessageId });
      }
      for (const row of updatedMentions) changed.set(stableJson([row.chatType, row.chatId, row.messageId]), row);

      // LINE's _chat._unreadCount is the only authority: listed chats take that count, every other conversation of this
      // account becomes 0. Only rows whose value changes are written (updated_at is left alone to keep list order).
      let unreadChanged = 0;
      if (unreadEntries !== undefined) {
        const wanted = JSON.stringify(unreadEntries.map(([chatId, count]) => ({ chat_id: chatId, count })));
        const updated = await client.query(
          `WITH wanted AS (SELECT chat_id,count FROM jsonb_to_recordset($2::jsonb) AS w(chat_id text,count integer))
           UPDATE conversations c SET unread_count=COALESCE((SELECT w.count FROM wanted w WHERE w.chat_id=c.chat_id),0)
           WHERE c.account_id=$1 AND c.chat_id <> '__local_agent_room__'
             AND c.unread_count IS DISTINCT FROM COALESCE((SELECT w.count FROM wanted w WHERE w.chat_id=c.chat_id),0)`,
          [input.accountId, wanted]);
        unreadChanged = updated.rowCount ?? 0;
        if (unreadChanged > 0) await ensureBatchReceipt();
      }

      const result: ExternalDirectPollResult = { staged: forward.length, projected, conflicts, replayed: false,
        changedMessages: [...changed.values()], tailRepaired, unreadChanged };
      if (receiptWritten) await client.query('UPDATE external_source_batches SET result=$4::jsonb WHERE source_id=$1 AND generation=$2 AND batch_id=$3',
        [input.sourceId, input.generation, input.batchId, JSON.stringify(result)]);
      return result;
    });
  }

  private async repairProjectedObservation(client: PoolClient, input: ExternalObservationBatch,
    observation: ExternalObservation): Promise<{ status: 'OK' | 'CONFLICT'; changed: boolean }> {
    if (!observation.canonicalMessageId) return { status: 'OK', changed: false };
    const provenance = await client.query<{ message_id: string }>(
      'SELECT message_id FROM message_source_provenance WHERE source_id=$1 AND generation=$2 AND observation_id=$3 FOR UPDATE',
      [input.sourceId, input.generation, observation.observationId]);
    if (provenance.rows[0] && provenance.rows[0].message_id !== observation.canonicalMessageId) return { status: 'CONFLICT', changed: false };
    const changed = await upsertCanonicalLineMessage(client, input.accountId, input.sourceId, observation);
    if (!provenance.rows[0]) await client.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
      VALUES ($1,$2,$3,$4,$5,'EXTERNAL_MONITOR',true)`,
    [input.accountId, observation.canonicalMessageId, input.sourceId, input.generation, observation.observationId]);
    return { status: 'OK', changed };
  }
}

const MAX_TAIL_IDS = 50;
function normalizeTailCursor(value: unknown): ExternalTailCursor {
  if (!isPlainRecord(value) || typeof value.createdTime !== 'string' || !/^\d{1,16}$/.test(value.createdTime)
    || typeof value.id !== 'string' || !value.id || value.id.length > 512) throw new Error('Invalid external tail window cursor');
  return { createdTime: value.createdTime, id: value.id };
}
function normalizeTailWindow(value: ExternalTailWindow): ExternalTailWindow {
  if (!isPlainRecord(value) || !Array.isArray(value.ids) || value.ids.length > MAX_TAIL_IDS
    || value.ids.some((id) => typeof id !== 'string' || !id || id.length > 512) || new Set(value.ids).size !== value.ids.length) {
    throw new Error('Invalid external tail window ids');
  }
  return { upper: normalizeTailCursor(value.upper), lower: value.lower === null ? null : normalizeTailCursor(value.lower),
    ids: [...value.ids] };
}

/**
 * Marks messages of this source whose original row is missing from a complete round tail (deleted at the source) and clears
 * the mark of tail rows that are visible again. Touches only `messages.raw.sourceDeleted`; the exact lower-boundary
 * millisecond is never judged.
 */
async function reconcileSourceDeletions(client: PoolClient, input: ExternalDirectPollInput, window: ExternalTailWindow,
  tail: readonly ExternalObservation[], forward: readonly ExternalObservation[]): Promise<ExternalChangedMessage[]> {
  const present = [...window.ids.map((id) => `official-line-db:${id}`), ...tail.map((row) => row.observationId)];
  for (const row of forward) present.push(row.observationId);
  const epochMs = "round(extract(epoch from date_trunc('milliseconds', m.occurred_at))::numeric * 1000)::bigint";
  const missing = await client.query<{ chat_type: ChatType; chat_id: string; message_id: string }>(
    `SELECT m.chat_type,m.chat_id,m.message_id FROM messages m
     WHERE m.account_id=$1 AND NOT (m.raw ? 'sourceDeleted') AND m.message_id IN (
       SELECT p.message_id FROM message_source_provenance p
       WHERE p.account_id=$1 AND p.source_id=$2 AND p.generation=$3 AND p.observation_id LIKE 'official-line-db:%'
        AND NOT (p.observation_id = ANY($4::text[])))
      AND ${epochMs} <= $5::bigint AND ($6::bigint IS NULL OR ${epochMs} > $6::bigint)
     ORDER BY m.occurred_at DESC,m.message_id DESC LIMIT 50 FOR UPDATE OF m`,
    [input.accountId, input.sourceId, input.generation, present, window.upper.createdTime, window.lower?.createdTime ?? null]);
  const changed: ExternalChangedMessage[] = [];
  if (missing.rows.length > 0) {
    await client.query(`UPDATE messages SET raw=COALESCE(raw,'{}'::jsonb) || jsonb_build_object('sourceDeleted',
      jsonb_build_object('detectedAt',$3::text)) WHERE account_id=$1 AND message_id=ANY($2::text[])`,
    [input.accountId, missing.rows.map((row) => row.message_id), new Date().toISOString()]);
    for (const row of missing.rows) changed.push({ chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id });
  }
  const ids = tail.map((row) => row.canonicalMessageId).filter((id): id is string => id !== null);
  if (ids.length > 0) {
    const cleared = await client.query<{ chat_type: ChatType; chat_id: string; message_id: string }>(
      `UPDATE messages SET raw=raw - 'sourceDeleted' WHERE account_id=$1 AND message_id=ANY($2::text[]) AND raw ? 'sourceDeleted'
       RETURNING chat_type,chat_id,message_id`, [input.accountId, ids]);
    for (const row of cleared.rows) changed.push({ chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id });
  }
  return changed;
}

async function canonicalLineMessageMatches(client: PoolClient, accountId: string,
  observation: ExternalObservation): Promise<boolean> {
  if (!observation.canonicalMessageId) return false;
  const existing = await client.query<{ chat_type: string; chat_id: string; sender_id: string; kind: string;
    text_content: string | null; content: MessageContent | null; content_rule_version: number; reply_to_message_id: string | null;
    occurred_at: Date | string; raw: Record<string, unknown> | null }>(
    'SELECT chat_type,chat_id,sender_id,kind,text_content,content,content_rule_version,reply_to_message_id,occurred_at,raw FROM messages WHERE account_id=$1 AND message_id=$2 FOR UPDATE',
    [accountId, observation.canonicalMessageId]);
  const prior = existing.rows[0];
  const projection = bridgeProjection(observation, prior, await chatEventNames(client, accountId, observation));
  return Boolean(prior && prior.chat_type === observation.chatType && prior.chat_id === observation.chatId
    && prior.sender_id === observation.senderId && prior.kind === projection.kind
    && (projection.content?.type === 'unsent' || prior.text_content === observation.text)
    && projectionMatches(prior, projection)
    && new Date(prior.occurred_at).getTime() === new Date(observation.occurredAt).getTime()
    && stableJson(prior.raw ?? {}) === stableJson(buildExternalMessageRaw(prior.raw ?? {}, observation)));
}

/** Names for a type-18 chat event's MIDs; undefined (no query) for every other row. */
async function chatEventNames(client: PoolClient, accountId: string, observation: ExternalObservation): Promise<ReadonlyMap<string, string> | undefined> {
  const mids = nativeChatEventMids(observation.nativePayload);
  return mids.length === 0 ? undefined : loadChatEventNames(client, accountId, observation.chatType, observation.chatId, mids);
}

type StoredProjection = { content: MessageContent | null; content_rule_version: number; reply_to_message_id: string | null };
type BridgeProjection = { kind: string; content: MessageContent | null; version: number; replyToMessageId: string | null };

/**
 * Layer 2 at write time: converts the observation's plaintext Layer-1 row with the content bridge, inside the caller's
 * insert transaction. A `dpapi` envelope (or none) cannot be read, so the stored projection stays unchanged.
 */
function bridgeProjection(observation: ExternalObservation, prior: StoredProjection | null | undefined,
  names?: ReadonlyMap<string, string>): BridgeProjection {
  const bridged = bridgeNativeEnvelope(observation.nativePayload, undefined, names);
  if (bridged) return { kind: bridged.kind, content: bridged.content, version: bridged.version, replyToMessageId: bridged.replyToMessageId };
  if (observation.livePayload) {
    const live = bridgeLiveMessage({ raw: observation.livePayload.raw, contact: observation.livePayload.contact });
    if (live) return { kind: live.kind, content: live.content, version: live.version, replyToMessageId: live.replyToMessageId };
  }
  return { kind: observation.kind, content: prior?.content ?? null, version: prior?.content_rule_version ?? 0,
    replyToMessageId: prior?.reply_to_message_id ?? null };
}
function projectionMatches(prior: StoredProjection, projection: BridgeProjection): boolean {
  return stableJson(prior.content ?? null) === stableJson(projection.content) && prior.content_rule_version === projection.version
    && (prior.reply_to_message_id ?? null) === projection.replyToMessageId;
}

function buildExternalMessageRaw(existing: Record<string, unknown>, observation: ExternalObservation): Record<string, unknown> {
  if (observation.livePayload) {
    const liveRaw = isPlainRecord(observation.livePayload.raw) ? observation.livePayload.raw : { workerRaw: observation.livePayload.raw };
    return { ...existing, ...liveRaw, ...(observation.livePayload.contact ? { loginContact: observation.livePayload.contact } : {}) };
  }
  const previousMessage = isPlainRecord(existing.message) ? existing.message : {};
  const previousMetadata = isPlainRecord(previousMessage.contentMetadata) ? previousMessage.contentMetadata : {};
  const retainedStickerMetadata = NativeStickerMetadataSchema.safeParse({
    ...(typeof previousMetadata.STKID === 'string' ? { STKID: previousMetadata.STKID } : {}),
    ...(typeof previousMetadata.STKPKGID === 'string' ? { STKPKGID: previousMetadata.STKPKGID } : {}),
    ...(typeof previousMetadata.STKVER === 'string' ? { STKVER: previousMetadata.STKVER } : {}),
    ...(typeof previousMetadata.STKTXT === 'string' ? { STKTXT: previousMetadata.STKTXT } : {}),
    ...(previousMetadata.STKOPT === 'A' ? { STKOPT: previousMetadata.STKOPT } : {}),
  });
  if (observation.nativePayload === undefined && observation.nativeStickerMetadata === undefined
    && existing.native === undefined && !retainedStickerMetadata.success) return existing;
  const contentMetadata: Record<string, unknown> = retainedStickerMetadata.success ? retainedStickerMetadata.data : {};
  if (observation.nativeStickerMetadata !== undefined) {
    if (typeof contentMetadata.STKID === 'string' && observation.nativeStickerMetadata.STKID !== contentMetadata.STKID) {
      delete contentMetadata.STKPKGID;
      delete contentMetadata.STKVER;
      delete contentMetadata.STKTXT;
      delete contentMetadata.STKOPT;
    }
    Object.assign(contentMetadata, observation.nativeStickerMetadata);
  }
  const message: Record<string, unknown> = {
    id: observation.canonicalMessageId,
    from: observation.senderId,
    contentType: observation.nativeContentType,
    createdTime: new Date(observation.occurredAt).getTime(),
    text: observation.text,
  };
  if (Object.keys(contentMetadata).length > 0) message.contentMetadata = contentMetadata;
  else delete message.contentMetadata;
  const native = observation.nativePayload
    ? (isPlainRecord(existing.native) && existing.native.sourceDigest === observation.nativePayload.sourceDigest
        && !(existing.native.encoding === 'dpapi' && observation.nativePayload.encoding === 'plain')
      ? existing.native : observation.nativePayload)
    : existing.native;
  // Keep the pre-recall Layer-1 snapshot once: only on the plain-not-recalled -> plain-recalled transition, never overwritten.
  const recall = existing.recall === undefined && observation.nativePayload !== undefined && existing.native !== undefined
    && !isRecalledNativeEnvelope(existing.native) && isNativePlainMessage(existing.native)
    && isRecalledNativeEnvelope(observation.nativePayload)
    ? { original: existing.native, recalledAt: new Date().toISOString() } : undefined;
  return { ...existing, message, ...(native === undefined ? {} : { native }), ...(recall === undefined ? {} : { recall }) };
}

function isNativePlainMessage(envelope: unknown): boolean {
  return isPlainRecord(envelope) && envelope.format === 2 && envelope.encoding === 'plain' && envelope.table === '_message';
}

/**
 * Authority of a source created before any Agent account existed: it records no administrator binding and is valid
 * only while no PRIMARY_ADMIN binding exists anywhere (the verified official identity is the sole authority).
 * Returns the superset of columns the authority checks read, with the binding fields mirroring the account's own
 * MID so the usual equality checks stay meaningful, or undefined when the no-Agent authority does not apply.
 */
async function noAgentAuthority(client: PoolClient, accountId: string, sourceId: string, generation: number) {
  const result = await client.query<{ mode_revision: string; cursor: Record<string, unknown> | null; own_mid: string | null;
    verified_account_mid: string; state: string; identity_digest: string; source_type: string; read_capability: boolean;
    product_role: string | null; source_transition_state: string; transition_state: string; connection_mode: string }>(
    `SELECT a.mode_revision,c.cursor,a.own_mid,s.verified_account_mid,s.state,s.identity_digest,s.source_type,s.read_capability,
      a.product_role,a.source_transition_state,a.source_transition_state AS transition_state,a.connection_mode
     FROM line_accounts a JOIN line_account_sources s
      ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
     LEFT JOIN external_source_checkpoints c ON c.source_id=s.source_id AND c.account_id=a.account_id AND c.generation=s.generation
     WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 AND s.source_type='EXTERNAL_MONITOR'
      AND s.admin_binding_account_id IS NULL AND s.read_capability=true
      AND NOT EXISTS (SELECT 1 FROM account_administrators WHERE role='PRIMARY_ADMIN')
     FOR UPDATE OF a,s`, [accountId, sourceId, generation]);
  const row = result.rows[0];
  if (!row) return undefined;
  return { ...row, source_state: row.state, admin_binding_account_id: 'no-agent', admin_binding_mid: row.own_mid,
    admin_binding_version: '1', agent_role: 'AGENT', current_admin_mid: row.own_mid, current_admin_version: '1' };
}

/** The same source-authority fence every external-monitor write takes (selected, ACTIVE, STABLE, verified MID, current revision). */
async function assertExternalSourceAuthority(client: PoolClient,
  input: { accountId: string; sourceId: string; generation: number; expectedModeRevision: number }): Promise<void> {
  const authority = await client.query<{ mode_revision: string; state: string; source_type: string;
    connection_mode: string; transition_state: string; own_mid: string | null; verified_account_mid: string;
    admin_binding_mid: string | null; current_admin_mid: string | null; admin_binding_version: string | null;
    current_admin_version: string | null; product_role: string | null; agent_role: string | null; read_capability: boolean }>(
    `SELECT a.mode_revision,s.state,s.source_type,a.connection_mode,a.source_transition_state AS transition_state,
      a.own_mid,s.verified_account_mid,s.admin_binding_mid,admin.user_id AS current_admin_mid,
      s.admin_binding_version,av.version AS current_admin_version,a.product_role,agent.product_role AS agent_role,s.read_capability
     FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
      AND s.generation=a.selected_source_generation JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
     JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
     JOIN account_administrator_versions av ON av.account_id=agent.account_id
     WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 AND s.source_type='EXTERNAL_MONITOR'
     FOR UPDATE OF a,s,agent,admin,av`, [input.accountId, input.sourceId, input.generation]);
  const row = authority.rows[0] ?? await noAgentAuthority(client, input.accountId, input.sourceId, input.generation);
  if (!row || Number(row.mode_revision) !== input.expectedModeRevision || row.state !== 'ACTIVE'
    || row.source_type !== 'EXTERNAL_MONITOR' || row.connection_mode !== 'EXTERNAL_MONITOR' || row.transition_state !== 'STABLE'
    || row.own_mid !== row.verified_account_mid || row.own_mid !== row.admin_binding_mid || row.admin_binding_mid !== row.current_admin_mid
    || Number(row.admin_binding_version) !== Number(row.current_admin_version) || row.product_role !== 'PRIMARY_ADMIN'
    || row.agent_role !== 'AGENT' || !row.read_capability) throw new Error('External source authority is stale');
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function supportsInitialPageBulkWrite(observations: ExternalObservation[]): boolean {
  if (new Set(observations.map((row) => row.canonicalMessageId)).size !== observations.length) return false;
  const conversationMetadata = new Map<string, { title: string | null; nativeMetadata: string | null }>();
  for (const row of observations) {
    const key = stableJson([row.chatType, row.chatId]);
    const prior = conversationMetadata.get(key);
    const title = row.conversationTitle ?? null;
    const nativeMetadata = row.nativeMetadata === undefined ? null : stableJson(row.nativeMetadata);
    if (prior && ((title !== null && prior.title !== null && title !== prior.title)
      || (nativeMetadata !== null && prior.nativeMetadata !== null && nativeMetadata !== prior.nativeMetadata))) return false;
    conversationMetadata.set(key, { title: title ?? prior?.title ?? null,
      nativeMetadata: nativeMetadata ?? prior?.nativeMetadata ?? null });
  }
  return true;
}

async function projectInitialPageBulk(client: PoolClient, input: ExternalObservationBatch,
  observations: ExternalObservation[]): Promise<{ projected: number; newlyProjected: number; changedMessages: ExternalChangedMessage[] }> {
  const ids = observations.map((row) => row.observationId);
  const priorRows = await client.query<{ observation_id: string; normalized_digest: string; status: string;
    canonical_message_id: string | null; normalized_payload: ExternalObservation; raw_native_payload: unknown }>(
    `SELECT o.observation_id,o.normalized_digest,o.status,o.canonical_message_id,o.normalized_payload,m.raw->'native' AS raw_native_payload
      FROM external_source_observations o LEFT JOIN messages m
       ON m.account_id=o.account_id AND m.message_id=o.canonical_message_id
      WHERE o.source_id=$1 AND o.generation=$2 AND o.observation_id=ANY($3::text[]) FOR UPDATE OF o`,
    [input.sourceId, input.generation, ids]);
  const priorById = new Map(priorRows.rows.map((row) => [row.observation_id, row]));
  observations = observations.map((observation) => mergeStoredNativeFields(observation,
    priorById.get(observation.observationId)?.normalized_payload, priorById.get(observation.observationId)?.raw_native_payload));
  const newObservations: ExternalObservation[] = [];
  let projected = 0;
  for (const observation of observations) {
    const prior = priorById.get(observation.observationId);
    if (!prior) {
      newObservations.push(observation);
      continue;
    }
    const priorPayload = prior.normalized_payload ?? {};
    const allowedNativeRefresh = Boolean(observation.nativePayload || observation.nativeStickerMetadata
      || priorPayload.nativePayload || priorPayload.nativeStickerMetadata)
      && prior.canonical_message_id === observation.canonicalMessageId;
    if ((prior.normalized_digest !== canonicalDigest(observation) && !allowedNativeRefresh) || prior.status === 'CONFLICT') {
      throw new Error('External initial import page contains a conflict');
    }
    if (prior.status !== 'PROJECTED') throw new Error('External initial import found a staged observation');
    if (allowedNativeRefresh && (prior.normalized_digest !== canonicalDigest(observation)
      || nativeFieldsDiffer(priorPayload, observation))) {
      await client.query(`UPDATE external_source_observations SET batch_id=$4,normalized_digest=$5,normalized_payload=$6::jsonb
        WHERE source_id=$1 AND generation=$2 AND observation_id=$3`,
      [input.sourceId, input.generation, observation.observationId, input.batchId, canonicalDigest(observation), stableJson(observation)]);
    }
    projected++;
  }
  if (newObservations.length === 0) {
    const updatedNames = await upsertCommunityMemberNames(client, input.accountId, observations);
    const changedMessages = await upsertExternalMessagePage(client, input.accountId, input.sourceId, observations);
    changedMessages.push(...observations
      .filter((row) => {
        const key = communityMemberKey(row);
        return row.canonicalMessageId && key !== null && updatedNames.has(key);
      })
      .map((row) => ({ chatType: row.chatType, chatId: row.chatId, messageId: row.canonicalMessageId! })));
    addUniqueChangedMessages(changedMessages, await updateExternalMentionRanges(client, input.accountId, observations));
    return { projected, newlyProjected: 0, changedMessages };
  }

  const observationRows = newObservations.map((observation) => ({ observation_id: observation.observationId,
    canonical_message_id: observation.canonicalMessageId, normalized_digest: canonicalDigest(observation),
    normalized_payload: observation }));
  const staged = await client.query<{ observation_id: string }>(`INSERT INTO external_source_observations(source_id,account_id,generation,
      observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
    SELECT $1,$2,$3,row.observation_id,$4,row.canonical_message_id,row.normalized_digest,row.normalized_payload,'STAGED'
      FROM jsonb_to_recordset($5::jsonb) AS row(observation_id text,canonical_message_id text,normalized_digest text,normalized_payload jsonb)
    ON CONFLICT (source_id,generation,observation_id) DO NOTHING RETURNING observation_id`,
  [input.sourceId, input.accountId, input.generation, input.batchId, JSON.stringify(observationRows)]);
  if (staged.rowCount !== newObservations.length) throw new Error('External initial import observation changed during page write');

  const conversations = new Map<string, { chat_type: string; chat_id: string; title: string | null; native_metadata: unknown | null }>();
  for (const observation of newObservations) {
    const key = stableJson([observation.chatType, observation.chatId]);
    const row = conversations.get(key) ?? { chat_type: observation.chatType, chat_id: observation.chatId, title: null, native_metadata: null };
    if (observation.conversationTitle != null) row.title = observation.conversationTitle;
    if (observation.nativeMetadata !== undefined) row.native_metadata = observation.nativeMetadata;
    conversations.set(key, row);
  }
  const conversationRows = [...conversations.values()];
  const insertedConversations = await client.query<{ chat_type: string; chat_id: string }>(`INSERT INTO conversations(account_id,chat_type,chat_id,title,native_metadata)
    SELECT $1,row.chat_type,row.chat_id,COALESCE(row.title,''),COALESCE(row.native_metadata,
      '{"midType":null,"parentChatId":null,"communityId":null}'::jsonb)
      FROM jsonb_to_recordset($2::jsonb) AS row(chat_type text,chat_id text,title text,native_metadata jsonb)
    ON CONFLICT(account_id,chat_type,chat_id) DO NOTHING RETURNING chat_type,chat_id`,
  [input.accountId, JSON.stringify(conversationRows)]);
  const changedConversationKeys = new Set(insertedConversations.rows.map((row) => stableJson([row.chat_type, row.chat_id])));
  const conversationUpdates = conversationRows.filter((row) => row.title !== null || row.native_metadata !== null);
  if (conversationUpdates.length > 0) {
    const updatedConversations = await client.query<{ chat_type: string; chat_id: string }>(`UPDATE conversations AS conversation SET
        title=CASE WHEN supplied.title IS NULL THEN conversation.title ELSE supplied.title END,
        native_metadata=CASE WHEN supplied.native_metadata IS NULL THEN conversation.native_metadata ELSE supplied.native_metadata END,
        updated_at=now()
      FROM jsonb_to_recordset($1::jsonb) AS supplied(chat_type text,chat_id text,title text,native_metadata jsonb)
      WHERE conversation.account_id=$2 AND conversation.chat_type=supplied.chat_type AND conversation.chat_id=supplied.chat_id
        AND ((supplied.title IS NOT NULL AND conversation.title IS DISTINCT FROM supplied.title)
          OR (supplied.native_metadata IS NOT NULL AND conversation.native_metadata IS DISTINCT FROM supplied.native_metadata))
      RETURNING conversation.chat_type,conversation.chat_id`, [JSON.stringify(conversationUpdates), input.accountId]);
    for (const row of updatedConversations.rows) changedConversationKeys.add(stableJson([row.chat_type, row.chat_id]));
  }

  const updatedNames = await upsertCommunityMemberNames(client, input.accountId, observations);

  const messageChanged = await upsertExternalMessagePage(client, input.accountId, input.sourceId, observations);
  const changedMentionMessages = await updateExternalMentionRanges(client, input.accountId, observations);
  await client.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
    SELECT $1,row.message_id,$2,$3,row.observation_id,'EXTERNAL_MONITOR',true
      FROM jsonb_to_recordset($4::jsonb) AS row(message_id text,observation_id text)
    ON CONFLICT DO NOTHING`, [input.accountId, input.sourceId, input.generation, JSON.stringify(newObservations.map((row) => ({
    message_id: row.canonicalMessageId, observation_id: row.observationId }))) ]);
  const projectedRows = await client.query(`UPDATE external_source_observations SET status='PROJECTED'
    WHERE source_id=$1 AND generation=$2 AND observation_id=ANY($3::text[]) AND status='STAGED'`,
  [input.sourceId, input.generation, newObservations.map((row) => row.observationId)]);
  if (projectedRows.rowCount !== newObservations.length) throw new Error('External initial import observation projection changed during page write');
  const changedMessageKeys = new Set(messageChanged.map((row) => stableJson([row.chatType, row.chatId, row.messageId])));
  const changed: ExternalChangedMessage[] = observations.flatMap((observation) => {
    const key = stableJson([observation.chatType, observation.chatId, observation.canonicalMessageId]);
    if (!observation.canonicalMessageId || (!changedMessageKeys.has(key)
      && !changedConversationKeys.has(stableJson([observation.chatType, observation.chatId])))) return [];
    return [{ chatType: observation.chatType, chatId: observation.chatId, messageId: observation.canonicalMessageId }];
  });
  addNameChangedMessages(changed, observations, updatedNames);
  addUniqueChangedMessages(changed, changedMentionMessages);
  return { projected: projected + newObservations.length, newlyProjected: newObservations.length, changedMessages: changed };
}

async function upsertExternalMessagePage(client: PoolClient, accountId: string, sourceId: string,
  observations: ExternalObservation[]): Promise<ExternalChangedMessage[]> {
  const eligible = observations.filter((row) => row.canonicalMessageId !== null);
  if (eligible.length === 0) return [];
  const ids = eligible.map((row) => row.canonicalMessageId!);
  const existing = await client.query<{ message_id: string; chat_type: ChatType; chat_id: string; sender_id: string; kind: string;
    text_content: string | null; content: MessageContent | null; content_rule_version: number; reply_to_message_id: string | null;
    occurred_at: Date | string; raw: Record<string, unknown> | null }>(
    `SELECT message_id,chat_type,chat_id,sender_id,kind,text_content,content,content_rule_version,reply_to_message_id,occurred_at,raw FROM messages
      WHERE account_id=$1 AND message_id=ANY($2::text[]) FOR UPDATE`, [accountId, ids]);
  const priorById = new Map(existing.rows.map((row) => [row.message_id, row]));
  const eventNames = new Map<string, ReadonlyMap<string, string> | undefined>();
  for (const observation of eligible) eventNames.set(observation.canonicalMessageId!, await chatEventNames(client, accountId, observation));
  const writes = eligible.flatMap((observation) => {
    const prior = priorById.get(observation.canonicalMessageId!);
    const raw = buildExternalMessageRaw(prior?.raw ?? {}, observation);
    const projection = bridgeProjection(observation, prior, eventNames.get(observation.canonicalMessageId!));
    const changed = !prior || prior.chat_type !== observation.chatType || prior.chat_id !== observation.chatId
      || prior.sender_id !== observation.senderId || prior.kind !== projection.kind || prior.text_content !== observation.text
      || !projectionMatches(prior, projection)
      || new Date(prior.occurred_at).getTime() !== new Date(observation.occurredAt).getTime()
      || stableJson(prior.raw ?? {}) !== stableJson(raw);
    return changed ? [{ message_id: observation.canonicalMessageId, observation_id: observation.observationId,
      chat_type: observation.chatType, chat_id: observation.chatId, sender_id: observation.senderId,
      kind: projection.kind, text_content: observation.text, content: projection.content,
      content_rule_version: projection.version, reply_to_message_id: projection.replyToMessageId,
      occurred_at: observation.occurredAt, raw }] : [];
  });
  if (writes.length > 0) await client.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,content,
      content_rule_version,reply_to_message_id,mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
    SELECT $1,row.message_id,'external:' || $2 || ':' || row.observation_id,row.chat_type,row.chat_id,row.sender_id,row.kind,row.text_content,row.content,
      row.content_rule_version,row.reply_to_message_id,'[]'::jsonb,'[]'::jsonb,'history',row.occurred_at::timestamptz,row.raw
      FROM jsonb_to_recordset($3::jsonb) AS row(message_id text,observation_id text,chat_type text,chat_id text,sender_id text,
        kind text,text_content text,content jsonb,content_rule_version integer,reply_to_message_id text,occurred_at text,raw jsonb)
    ON CONFLICT(account_id,message_id) DO UPDATE SET chat_type=EXCLUDED.chat_type,chat_id=EXCLUDED.chat_id,
      sender_id=EXCLUDED.sender_id,kind=EXCLUDED.kind,
      text_content=CASE WHEN EXCLUDED.content->>'type'='unsent' THEN messages.text_content ELSE EXCLUDED.text_content END,content=EXCLUDED.content,
      content_rule_version=EXCLUDED.content_rule_version,reply_to_message_id=EXCLUDED.reply_to_message_id,occurred_at=EXCLUDED.occurred_at,raw=EXCLUDED.raw`,
  [accountId, sourceId, JSON.stringify(writes)]);
  await upsertExternalAttachments(client, accountId, eligible);
  return writes.map((row) => ({ chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id! }));
}

async function upsertExternalAttachments(client: PoolClient, accountId: string, observations: ExternalObservation[]): Promise<void> {
  const rows = observations.flatMap((row) => row.canonicalMessageId && row.attachments
    ? row.attachments.map((attachment) => ({ message_id: row.canonicalMessageId!, chat_type: row.chatType,
      chat_id: row.chatId, external_attachment_id: attachment.id, kind: attachment.kind,
      name: attachment.name, mime_type: attachment.mimeType, size_bytes: attachment.sizeBytes })) : []);
  if (rows.length === 0) return;
  await client.query(`INSERT INTO attachments(external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,error)
    SELECT row.external_attachment_id,$1,row.chat_type,row.chat_id,row.message_id,row.kind,row.name,row.mime_type,row.size_bytes,
      'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE'
      FROM jsonb_to_recordset($2::jsonb) AS row(external_attachment_id text,chat_type text,chat_id text,message_id text,
        kind text,name text,mime_type text,size_bytes bigint)
    ON CONFLICT(account_id,chat_type,chat_id,message_id,external_attachment_id) DO UPDATE SET
      kind=EXCLUDED.kind,name=COALESCE(EXCLUDED.name,attachments.name),mime_type=COALESCE(EXCLUDED.mime_type,attachments.mime_type),
      size_bytes=COALESCE(EXCLUDED.size_bytes,attachments.size_bytes),updated_at=now()
    WHERE attachments.kind IS DISTINCT FROM EXCLUDED.kind OR (EXCLUDED.name IS NOT NULL AND attachments.name IS DISTINCT FROM EXCLUDED.name)
      OR (EXCLUDED.mime_type IS NOT NULL AND attachments.mime_type IS DISTINCT FROM EXCLUDED.mime_type)
      OR (EXCLUDED.size_bytes IS NOT NULL AND attachments.size_bytes IS DISTINCT FROM EXCLUDED.size_bytes)`,
  [accountId, JSON.stringify(rows)]);
}

function communityMemberKey(observation: ExternalObservation): string | null {
  if ((observation.chatType !== 'community' && observation.chatType !== 'thread') || !observation.senderId
    || ((!observation.senderName || observation.senderName.length > 256 || observation.senderName.trim().length === 0
      || observation.senderName.includes('\0')) && !normalizeNativePicturePath(observation.senderPicturePath))) return null;
  return stableJson([observation.chatType, observation.chatId, observation.senderId]);
}

async function upsertCommunityMemberNames(client: PoolClient, accountId: string,
  observations: ExternalObservation[]): Promise<Set<string>> {
  const names = new Map<string, { chat_type: string; chat_id: string; member_id: string; display_name: string | null; picture_path: string | null }>();
  for (const observation of observations) {
    const key = communityMemberKey(observation);
    if (!key) continue;
    names.set(key, { chat_type: observation.chatType, chat_id: observation.chatId,
      member_id: observation.senderId, display_name: observation.senderName ?? null,
      picture_path: normalizeNativePicturePath(observation.senderPicturePath) });
  }
  if (names.size === 0) return new Set();
  const updated = await client.query<{ chat_type: string; chat_id: string; member_id: string }>(`INSERT INTO conversation_members(
      account_id,chat_type,chat_id,member_id,display_name,picture_path)
    SELECT $1,row.chat_type,row.chat_id,row.member_id,row.display_name,row.picture_path
      FROM jsonb_to_recordset($2::jsonb) AS row(chat_type text,chat_id text,member_id text,display_name text,picture_path text)
    ON CONFLICT(account_id,chat_type,chat_id,member_id) DO UPDATE SET
      display_name=COALESCE(EXCLUDED.display_name,conversation_members.display_name),
      picture_path=COALESCE(EXCLUDED.picture_path,conversation_members.picture_path),updated_at=now()
      WHERE conversation_members.display_name IS DISTINCT FROM COALESCE(EXCLUDED.display_name,conversation_members.display_name)
        OR conversation_members.picture_path IS DISTINCT FROM COALESCE(EXCLUDED.picture_path,conversation_members.picture_path)
    RETURNING chat_type,chat_id,member_id`, [accountId, JSON.stringify([...names.values()])]);
  return new Set(updated.rows.map((row) => stableJson([row.chat_type, row.chat_id, row.member_id])));
}

function addNameChangedMessages(target: ExternalChangedMessage[], observations: ExternalObservation[],
  updatedNames: Set<string>): void {
  const changed = new Set(target.map((row) => stableJson([row.chatType, row.chatId, row.messageId])));
  for (const observation of observations) {
    const memberKey = communityMemberKey(observation);
    if (!observation.canonicalMessageId || memberKey === null || !updatedNames.has(memberKey)) continue;
    const key = stableJson([observation.chatType, observation.chatId, observation.canonicalMessageId]);
    if (changed.has(key)) continue;
    target.push({ chatType: observation.chatType, chatId: observation.chatId, messageId: observation.canonicalMessageId });
    changed.add(key);
  }
}

async function updateExternalMentionRanges(client: PoolClient, accountId: string,
  observations: ExternalObservation[]): Promise<ExternalChangedMessage[]> {
  const updates = new Map<string, { chat_type: string; chat_id: string; message_id: string;
    mention_ranges: MentionRange[]; mention_ids: string[] }>();
  for (const observation of observations) {
    if (!observation.canonicalMessageId || (!Array.isArray(observation.mentionRanges) && observation.mentionIds === undefined)) continue;
    const mentionRanges = Array.isArray(observation.mentionRanges) ? observation.mentionRanges as MentionRange[] : [];
    const key = stableJson([observation.chatType, observation.chatId, observation.canonicalMessageId]);
    updates.set(key, { chat_type: observation.chatType, chat_id: observation.chatId, message_id: observation.canonicalMessageId,
      mention_ranges: mentionRanges, mention_ids: observation.mentionIds ?? [...new Set(mentionRanges.map((range) => range.userId))] });
  }
  if (updates.size === 0) return [];
  const changed = await client.query<{ chat_type: ChatType; chat_id: string; message_id: string }>(`UPDATE messages AS message SET
      mention_ranges=supplied.mention_ranges,mention_ids=supplied.mention_ids
    FROM jsonb_to_recordset($2::jsonb) AS supplied(chat_type text,chat_id text,message_id text,mention_ranges jsonb,mention_ids jsonb)
    WHERE message.account_id=$1 AND message.chat_type=supplied.chat_type AND message.chat_id=supplied.chat_id
      AND message.message_id=supplied.message_id
      AND (message.mention_ranges IS DISTINCT FROM supplied.mention_ranges OR message.mention_ids IS DISTINCT FROM supplied.mention_ids)
    RETURNING message.chat_type,message.chat_id,message.message_id`, [accountId, JSON.stringify([...updates.values()])]);
  return changed.rows.map((row) => ({ chatType: row.chat_type, chatId: row.chat_id, messageId: row.message_id }));
}

function addUniqueChangedMessages(target: ExternalChangedMessage[], additions: ExternalChangedMessage[]): void {
  const changed = new Set(target.map((row) => stableJson([row.chatType, row.chatId, row.messageId])));
  for (const row of additions) {
    const key = stableJson([row.chatType, row.chatId, row.messageId]);
    if (changed.has(key)) continue;
    target.push(row);
    changed.add(key);
  }
}

async function upsertCanonicalLineMessage(client: PoolClient, accountId: string, sourceId: string,
  observation: ExternalObservation, ingestionSource: 'live' | 'history' = 'history'): Promise<boolean> {
  if (!observation.canonicalMessageId) throw new Error('External observation has no canonical message ID');
  const conversation = await client.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,native_metadata)
    VALUES ($1,$2,$3,COALESCE($4,''),COALESCE($5::jsonb,'{"midType":null,"parentChatId":null,"communityId":null}'::jsonb))
    ON CONFLICT(account_id,chat_type,chat_id) DO UPDATE SET
      title=CASE WHEN $4::text IS NULL THEN conversations.title ELSE $4 END,
      native_metadata=CASE WHEN $5::jsonb IS NULL THEN conversations.native_metadata ELSE $5::jsonb END,
      updated_at=CASE WHEN ($4::text IS NOT NULL AND conversations.title IS DISTINCT FROM $4)
        OR ($5::jsonb IS NOT NULL AND conversations.native_metadata IS DISTINCT FROM $5::jsonb)
        THEN now() ELSE conversations.updated_at END
    WHERE ($4::text IS NOT NULL AND conversations.title IS DISTINCT FROM $4)
      OR ($5::jsonb IS NOT NULL AND conversations.native_metadata IS DISTINCT FROM $5::jsonb)
    RETURNING 1`, [accountId, observation.chatType, observation.chatId, observation.conversationTitle ?? null,
    observation.nativeMetadata === undefined ? null : JSON.stringify(observation.nativeMetadata)]);
  const conversationChanged = (conversation.rowCount ?? 0) > 0;
  if (await canonicalLineMessageMatches(client, accountId, observation)) {
    await upsertExternalAttachments(client, accountId, [observation]);
    const mentionChanged = await updateExternalMentionRanges(client, accountId, [observation]);
    return conversationChanged || mentionChanged.length > 0;
  }
  const existingRaw = await client.query<{ raw: Record<string, unknown> | null; content: MessageContent | null;
    content_rule_version: number; reply_to_message_id: string | null }>(
    'SELECT raw,content,content_rule_version,reply_to_message_id FROM messages WHERE account_id=$1 AND message_id=$2 FOR UPDATE',
    [accountId, observation.canonicalMessageId]);
  const raw = buildExternalMessageRaw(existingRaw.rows[0]?.raw ?? {}, observation);
  const projection = bridgeProjection(observation, existingRaw.rows[0], await chatEventNames(client, accountId, observation));
  await client.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,content,content_rule_version,
    reply_to_message_id,mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'[]'::jsonb,'[]'::jsonb,$14,$12::timestamptz,$13::jsonb)
    ON CONFLICT (account_id,message_id) DO UPDATE SET chat_type=EXCLUDED.chat_type,chat_id=EXCLUDED.chat_id,
      sender_id=EXCLUDED.sender_id,kind=EXCLUDED.kind,
      text_content=CASE WHEN EXCLUDED.content->>'type'='unsent' THEN messages.text_content ELSE EXCLUDED.text_content END,content=EXCLUDED.content,
      content_rule_version=EXCLUDED.content_rule_version,reply_to_message_id=EXCLUDED.reply_to_message_id,
      occurred_at=EXCLUDED.occurred_at,raw=EXCLUDED.raw`,
  [accountId, observation.canonicalMessageId, observation.livePayload?.eventId ?? `external:${sourceId}:${observation.observationId}`,
    observation.chatType, observation.chatId, observation.senderId, projection.kind, observation.text,
    projection.content === null ? null : JSON.stringify(projection.content), projection.version, projection.replyToMessageId,
    observation.occurredAt, JSON.stringify(raw), ingestionSource]);
  await upsertExternalAttachments(client, accountId, [observation]);
  await updateExternalMentionRanges(client, accountId, [observation]);
  return true;
}
