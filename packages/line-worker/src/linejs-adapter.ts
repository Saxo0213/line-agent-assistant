import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseClient, InternalError } from '@evex/linejs/base';
import { MemoryStorage } from '@evex/linejs/storage';
import { Protocols } from '@evex/linejs/thrift';
import { buildMentionContentMetadata, normalizeNativePicturePath, type OutgoingMention, relationAddServerError, TALK_SERVER_ERRORS, type AccountMode, type ChatResourceReadCommand, type ConversationCatalogItem, type DownloadAuthProbe, type JsonValue, type NativeAttachmentDownloadInput, type RelationAddServerErrorCode, type TalkCursorV1Dto } from '@line-agent/contracts';
import {
  createMutationGate, EffectDeniedError, isReadOnlyRpc,
  type ControlLease, type ControlLeasePhase, type DirectFetchEffect, type MediaUploadScope, type RpcCallContext, type RpcTransportState, type ServerLogoutPermit,
  type ChatResourceFetchEffect,
  type TrustedInvocationDispatch, type TrustedRequestClient,
} from './mutation-gate.js';
import { MediaUploadFailedError, tagMediaStage, type MediaUploadStage } from './worker-loop.js';
import type { FriendAddResult, FriendRelation, FriendRelationDiagnostic, LineTransport, RelationCancellation, SyncResult, TransportIdentity } from './worker-loop.js';
import type { HistoryCursorV1 } from './cursor.js';
import { safeRaw } from './normalizer.js';
import { verifyLinejsPackage } from './version.js';
import { trafficLabel } from './traffic-log.js';
import { SafeAttachmentError } from './attachment-error.js';
import { parseEncryptedAccessToken, validateAttachmentMessage, validateNativeAttachment, type AttachmentDownloadIdentity } from './attachment-download.js';
import { boundedChatResourceResponseCode, ChatResourceFailure, safeChatResourceFailureDetails,
  safeChatResourceUpstreamCode, safeChatResourceUpstreamNumber } from './chat-resource-error.js';
import { decodeLinejsServerRejection, isLineServerRejection, isTalkAuthInvalidation } from './line-server-error.js';

type OpaqueCall = () => Promise<unknown>;
type SourceCall = Readonly<{
  methodName: string;
  path: string;
  value: Parameters<BaseClient['request']['request']>[0];
  protocolType: Parameters<BaseClient['request']['request']>[2];
  headers: Record<string, string | undefined>;
}>;
type AttachmentDownloadContext = Readonly<{ signal: AbortSignal; maxBytes: number }>;
/** Bounds only the token RPC and OBS preflight responses during download-auth adoption. */
const DOWNLOAD_AUTH_PREFLIGHT_MAX_BYTES = 64 * 1024;
type RelationAddContext = { consumed: boolean; signal: RelationCancellation; onPhysicalStart: () => void };
type ServerLogoutContext = Readonly<{ permit: ServerLogoutPermit; signal: AbortSignal }>;

function isExplicitAuthInvalidation(error: unknown): boolean {
  if (!(error instanceof InternalError) || error.name !== 'RequestError' || error.type !== 'RequestError'
    || !error.data || typeof error.data !== 'object' || Array.isArray(error.data)) return false;
  const code = Object.getOwnPropertyDescriptor(error.data, 'code');
  return !!code && Object.hasOwn(code, 'value')
    && ['AUTHENTICATION_FAILED', 'NOT_AVAILABLE_USER', 'NOT_AUTHORIZED_DEVICE'].includes(String(code.value));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('LINE server logout aborted'));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('LINE server logout aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

const FRIEND_ADD_RESULT_ERRORS = [
  'UNKNOWN', 'INVALID_TARGET_USER', 'AGE_VALIDATION', 'TOO_MANY_FRIENDS', 'TOO_MANY_REQUESTS',
  'MALFORMED_REQUEST', 'TRACKING_META_QRCODE_FAVORED', 'TRACKING_META_UPGRADE_FAVORED',
] as const;
const FRIEND_ADD_REJECTION_NAMES = new Set<string>(FRIEND_ADD_RESULT_ERRORS);

export function friendAddResultCode(value: unknown): RelationAddServerErrorCode | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < FRIEND_ADD_RESULT_ERRORS.length) {
    return relationAddServerError(FRIEND_ADD_RESULT_ERRORS[value])?.code ?? null;
  }
  return null;
}

export function friendAddRejectionReason(value: unknown): RelationAddServerErrorCode | null {
  return friendAddResultCode(value) ?? (typeof value === 'string' && FRIEND_ADD_REJECTION_NAMES.has(value)
    ? relationAddServerError(value)?.code ?? null : null);
}

function ownDataValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function friendAddRejectionError(error: unknown): RelationAddServerErrorCode | null {
  if (!(error instanceof InternalError) || error.name !== 'RequestError' || error.type !== 'RequestError') return null;
  if (!error.data || typeof error.data !== 'object' || Array.isArray(error.data)) return null;
  const data = error.data as Record<string, unknown>;
  if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return null;
  const gatewayError = friendAddResultCode(ownDataValue(data, 'code'));
  if (gatewayError) return gatewayError;
  const nested = ownDataValue(data, 'be');
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)
    || (Object.getPrototypeOf(nested) !== Object.prototype && Object.getPrototypeOf(nested) !== null)) return null;
  return friendAddRejectionReason(ownDataValue(nested, 'rejectionReason'));
}

function isNotAuthorizedDeviceRequestError(error: unknown): boolean {
  if (!(error instanceof InternalError) || error.name !== 'RequestError' || error.type !== 'RequestError') return false;
  if (!error.data || typeof error.data !== 'object' || Array.isArray(error.data)) return false;
  const data = error.data as Record<string, unknown>;
  if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return false;
  return ownDataValue(data, 'code') === 'NOT_AUTHORIZED_DEVICE';
}

export type LinejsAdapterOptions = Readonly<ControlLease & {
  mode: AccountMode;
  application?: string;
  validateLease: (lease: ControlLease) => boolean | Promise<boolean>;
  physicalTransport: (request: Request) => Promise<Response>;
  packageRoot?: string;
}>;

/** An OBS upload answered with a non-2xx status. The number is a property, so the media failure detail keeps it. */
export class ObsUploadHttpError extends Error {
  constructor(readonly status: number) { super(`OBS upload HTTP ${status}`); this.name = 'ObsUploadHttpError'; }
}

export class ProtocolUnverifiedError extends Error {
  readonly code = 'PROTOCOL_UNVERIFIED';
  constructor(reason: string) { super(reason); this.name = 'ProtocolUnverifiedError'; }
}

type E2eeMediaDownloader = Readonly<{
  downloadMediaByE2EE(message: never): Promise<File | null>;
  downloadMessageData(options: { messageId: string; isPreview: boolean; isSquare: boolean }): Promise<File>;
}>;
export type DownloadedAttachment = Readonly<{
  name: string | null;
  source: AsyncIterable<Uint8Array>;
}>;

function attachmentTalkMeta(messageId: string): string {
  const id = Buffer.from(messageId, 'utf8');
  const thriftMessage = Buffer.concat([
    Buffer.from([11, 0, 4]), Buffer.from([id.length >>> 24, id.length >>> 16 & 255, id.length >>> 8 & 255, id.length & 255]), id,
    Buffer.from([15, 0, 27, 12, 0, 0, 0, 0, 0]),
  ]);
  return Buffer.from(JSON.stringify({ message: thriftMessage.toString('base64') })).toString('base64');
}

function attachmentHeaders(base: BaseClient, token: string, talkMeta: string | null): Headers {
  const headers = new Headers(Object.fromEntries(Object.entries(base.request.getHeader('GET'))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  headers.delete('host');
  headers.set('x-line-application', base.request.systemType);
  headers.set('x-line-access', token);
  if (talkMeta !== null) headers.set('x-talk-meta', talkMeta);
  return headers;
}

function attachmentUrl(path: string, obsPop: string | null): string {
  const url = new URL(`https://obs.line-apps.com${path}`);
  if (obsPop !== null) url.searchParams.set('p', obsPop);
  return url.toString();
}

async function readBoundedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
    rejectAbort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) throw new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* stream already cancelled */ }
  }
}

async function cancelResponse(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined); }

async function abortableAttachmentDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 2_000);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function nativeHttpFailure(status: number): SafeAttachmentError {
  return status >= 400 && status <= 599
    ? new SafeAttachmentError(`LINE_OBS_HTTP_${status}`)
    : new SafeAttachmentError('LINE_OBS_HTTP_FAILED');
}

async function responseForObs(gate: ReturnType<typeof createMutationGate<OpaqueCall, unknown, Response>>,
  context: { phase: 'MONITOR_READ' | 'CONTROL_READ'; lease?: ControlLease }, request: Request): Promise<Response> {
  return await gate.runFetch(context, request);
}

async function preflightAttachment(
  gate: ReturnType<typeof createMutationGate<OpaqueCall, unknown, Response>>,
  context: { phase: 'MONITOR_READ' | 'CONTROL_READ'; lease?: ControlLease },
  options: { path: string; headers: Headers; obsPop: string | null; signal: AbortSignal },
): Promise<'ready' | 'incomplete'> {
  const request = new Request(attachmentUrl(`${options.path}/object_info.obs`, options.obsPop), {
    method: 'GET', headers: options.headers, signal: options.signal, redirect: 'error',
  });
  const response = await responseForObs(gate, context, request);
  if (response.status === 202) { await cancelResponse(response); return 'incomplete'; }
  if (response.status !== 200) { await cancelResponse(response); throw nativeHttpFailure(response.status); }
  const bytes = await readBoundedResponse(response, 16 * 1024, options.signal);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new SafeAttachmentError('LINE_OBS_METADATA_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SafeAttachmentError('LINE_OBS_METADATA_INVALID');
  const info = parsed as Record<string, unknown>;
  if (typeof info.status !== 'string' || (info.encodeStatus !== undefined && typeof info.encodeStatus !== 'string')) {
    throw new SafeAttachmentError('LINE_OBS_METADATA_INVALID');
  }
  if (info.status === 'notexist') throw new SafeAttachmentError('LINE_OBS_OBJECT_NOT_FOUND');
  if (info.status !== 'exist') throw new SafeAttachmentError('LINE_OBS_METADATA_INVALID');
  return info.encodeStatus === 'ing' ? 'incomplete' : 'ready';
}

async function decryptVideo(e2ee: BaseClient['e2ee'], ciphertext: Buffer, keyMaterial: Buffer): Promise<Buffer> {
  if (ciphertext.length < 32) throw new SafeAttachmentError('LINE_MEDIA_AUTH_FAILED');
  const body = ciphertext.subarray(0, -32);
  const tag = ciphertext.subarray(-32);
  const keys = await e2ee.deriveKeyMaterial(keyMaterial);
  const mac = createHmac('sha256', keys.macKey);
  const chunkSize = 128 * 1024;
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    mac.update(createHash('sha256').update(body.subarray(offset, Math.min(offset + chunkSize, body.length))).digest());
  }
  const expected = mac.digest();
  if (!timingSafeEqual(tag, expected)) throw new SafeAttachmentError('LINE_MEDIA_AUTH_FAILED');
  return await e2ee.___decryptAESCTR(keys.encKey, keys.nonce, body);
}

async function* singleAttachmentChunk(bytes: Buffer): AsyncIterable<Uint8Array> { yield bytes; }

/** Wraps all LINEJS attachment response bodies, including chunked responses, before library buffering. */
export function limitDownloadResponse(response: Response, maxBytes: number): Response {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Invalid attachment byte limit');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new RangeError('Attachment exceeded the configured byte limit');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let totalBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); reader.releaseLock(); return; }
        totalBytes += next.value.byteLength;
        if (totalBytes > maxBytes) {
          const error = new RangeError('Attachment exceeded the configured byte limit');
          void reader.cancel(error).then(() => reader.releaseLock(), () => undefined);
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        try { controller.error(error); } catch { /* already cancelled */ }
        try { reader.releaseLock(); } catch { /* reader is still active */ }
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { try { reader.releaseLock(); } catch { /* already released */ } }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function limitChatResourceBootstrapResponse(response: Response, maxBytes: number): Response {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid channel-token bootstrap byte limit');
  return limitDownloadResponse(response, Math.min(maxBytes, 64 * 1024));
}

function restoreBinaryJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreBinaryJson);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if (item.encoding === 'base64' && typeof item.data === 'string' && Object.keys(item).length === 2) {
    return new Uint8Array(Buffer.from(item.data, 'base64'));
  }
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, restoreBinaryJson(entry)]));
}

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

async function* fileChunks(file: File): AsyncIterable<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally { reader.releaseLock(); }
}

export async function downloadLinejsE2eeAttachment(
  obs: E2eeMediaDownloader,
  lineMessage: JsonValue,
  maxBytes?: number,
): Promise<DownloadedAttachment> {
  if (maxBytes !== undefined) assertBinaryJsonWithinLimit(lineMessage, maxBytes);
  const restored = restoreBinaryJson(lineMessage) as { id?: unknown; chunks?: unknown };
  const file = Array.isArray(restored.chunks) && restored.chunks.length > 0
    ? await obs.downloadMediaByE2EE(restored as never)
    : typeof restored.id === 'string'
      ? await obs.downloadMessageData({ messageId: restored.id, isPreview: false, isSquare: false })
      : null;
  if (!file) throw new Error('LINEJS media is unavailable');
  if (maxBytes !== undefined && file.size > maxBytes) throw new RangeError('Attachment exceeded the configured byte limit');
  return { name: file.name || null, source: fileChunks(file) };
}

function classifyNativeAttachmentFailure(error: unknown): SafeAttachmentError {
  if (error instanceof EffectDeniedError) return new SafeAttachmentError('ATTACHMENT_EFFECT_DENIED');
  if (error instanceof InternalError) {
    if (error.type === 'ObsError') {
      const status = error.data.status;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
        return new SafeAttachmentError(`LINE_OBS_HTTP_${status}`);
      }
    }
    if (error.type === 'E2EEMediaError') return new SafeAttachmentError('LINE_MEDIA_AUTH_FAILED');
    if (error.type === 'NoE2EEKey') return new SafeAttachmentError('LINE_E2EE_SELF_KEY_MISSING');
    if (error.type === 'No E2EEKey') return new SafeAttachmentError('LINE_E2EE_PEER_KEY_UNAVAILABLE');
    if (error.type === 'E2EEKeyMismatch') return new SafeAttachmentError('LINE_E2EE_KEY_MISMATCH');
    if (error.type === 'Not support E2EE') return new SafeAttachmentError('LINE_E2EE_UNSUPPORTED');
    if (error.type === 'RequestError') return new SafeAttachmentError(
      isNotAuthorizedDeviceRequestError(error) ? 'LINE_AUTH_INVALIDATED' : 'LINE_RPC_FAILED');
  }
  if (error instanceof RangeError && error.message === 'Attachment exceeded the configured byte limit') {
    return new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
  }
  if (error instanceof TypeError) return new SafeAttachmentError('LINE_NETWORK_FAILED');
  return new SafeAttachmentError('LINE_NATIVE_DOWNLOAD_FAILED');
}

function classifyAttachmentRpcPhase(error: unknown,
  phaseCode: 'LINE_E2EE_METADATA_RPC_FAILED' | 'LINE_OBS_TOKEN_RPC_FAILED', requestFailed: boolean): SafeAttachmentError {
  if (isLineServerRejection(error)) return new SafeAttachmentError(phaseCode, error.code, error.upstreamCode);
  const safe = error instanceof SafeAttachmentError ? error : classifyNativeAttachmentFailure(error);
  if (safe.code === 'LINE_AUTH_INVALIDATED' || safe.code === 'ATTACHMENT_EFFECT_DENIED'
    || safe.code === 'LINE_E2EE_SELF_KEY_MISSING' || safe.code === 'LINE_E2EE_PEER_KEY_UNAVAILABLE'
    || safe.code === 'LINE_E2EE_KEY_MISMATCH' || safe.code === 'LINE_E2EE_UNSUPPORTED') return safe;
  if (requestFailed || safe.code === 'LINE_RPC_FAILED' || phaseCode === 'LINE_OBS_TOKEN_RPC_FAILED') return new SafeAttachmentError(phaseCode);
  if (phaseCode === 'LINE_E2EE_METADATA_RPC_FAILED'
    && (safe.code === 'LINE_NATIVE_DOWNLOAD_FAILED' || safe.code === 'LINE_NETWORK_FAILED')) {
    return new SafeAttachmentError('LINE_E2EE_METADATA_DECRYPT_FAILED');
  }
  return safe;
}

function assertBinaryJsonWithinLimit(value: unknown, maxBytes: number): void {
  let total = 0;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (record.encoding === 'base64' && typeof record.data === 'string') {
      const text = record.data;
      const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
      total += Math.ceil(text.length * 3 / 4) - padding;
      if (total > maxBytes) throw new RangeError('Attachment exceeded the configured byte limit');
      return;
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(value);
}

function isV3Jwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof header.alg === 'string' &&
      ['ver', 'scp', 'exp', 'iat', 'sub', 'iss', 'aud'].some((key) => payload[key] !== undefined);
  } catch { return false; }
}
function extractJwtUserMids(value: string): string[] {
  const parts = value.split('.');
  if (parts.length !== 3) return [];
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    const mids: string[] = [];
    const visit = (item: unknown) => {
      if (typeof item === 'string') {
        if (/^u[0-9a-fA-F]{32}$/.test(item)) mids.push(item.toLowerCase());
        return;
      }
      if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
      if (item && typeof item === 'object') { for (const entry of Object.values(item as Record<string, unknown>)) visit(entry); }
    };
    visit(payload);
    return mids;
  } catch { return []; }
}
function decimal(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('unsafe LINE cursor number');
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new TypeError('invalid LINE cursor');
  return text;
}

type CatalogChat = Readonly<{
  chatMid?: unknown;
  chatName?: unknown;
  picturePath?: unknown;
  extra?: { groupExtra?: { memberMids?: unknown } };
}>;
type CatalogTalk = Readonly<{
  ownMid: string;
  getAllChatMids(options: { request: { withMemberChats: true }; syncReason: 'INTERNAL' }): Promise<{ memberChatMids?: unknown }>;
  getMessageBoxes(options: { messageBoxListRequest: Record<string, never> }): Promise<{
    messageBoxes?: readonly Readonly<{ id?: unknown }>[];
  }>;
  getChats(options: { chatMids: string[] }): Promise<{ chats?: readonly CatalogChat[] }>;
  getContactsV2(options: { mids: string[] }): Promise<{ contacts?: unknown }>;
}>;

const CATALOG_BATCH_SIZE = 100;
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
function stringIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (value && typeof value === 'object') return Object.keys(value).filter((item) => item.length > 0);
  return [];
}
function chatType(chatId: string): ConversationCatalogItem['chatType'] | null {
  if (chatId.startsWith('u')) return 'direct';
  if (chatId.startsWith('c')) return 'group';
  if (chatId.startsWith('r')) return 'room';
  return null;
}

export function normalizeLinePicturePath(value: unknown, present = value !== undefined): string | null | undefined {
  if (!present) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || (!value.startsWith('/') && !value.startsWith('https://'))) return undefined;
  return normalizeNativePicturePath(value) ?? undefined;
}

/** Mirrors LINEJS Client.fetchJoinedChats while preserving the worker read gate. */
export async function fetchLinejsConversationCatalog(
  talk: CatalogTalk,
  invokeRead: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<ConversationCatalogItem[]> {
  const joined = await invokeRead(() => talk.getAllChatMids({
    request: { withMemberChats: true }, syncReason: 'INTERNAL',
  }));
  const boxes = await invokeRead(() => talk.getMessageBoxes({ messageBoxListRequest: {} }));
  const messageBoxIds = (boxes.messageBoxes ?? []).flatMap((box) =>
    typeof box.id === 'string' && chatType(box.id) !== null ? [box.id] : []);
  const chatMids = [...new Set([...messageBoxIds, ...stringIds(joined.memberChatMids)])];
  const joinedChatMids = chatMids.filter((chatId) => chatType(chatId) !== 'direct');
  const chats: CatalogChat[] = [];
  for (const batch of chunks(joinedChatMids, CATALOG_BATCH_SIZE)) {
    const response = await invokeRead(() => talk.getChats({ chatMids: batch }));
    chats.push(...(response.chats ?? []));
  }
  const chatsById = new Map(chats.flatMap((chat) => typeof chat.chatMid === 'string' ? [[chat.chatMid, chat] as const] : []));
  const normalized = chatMids.flatMap((chatId) => {
    const type = chatType(chatId);
    if (type === null) return [];
    const raw = type === 'direct' ? { chatMid: chatId } : chatsById.get(chatId);
    if (!raw) return [];
    const memberIds = type === 'direct'
      ? [chatId]
      : stringIds(raw.extra?.groupExtra?.memberMids).sort();
    return [{ raw, chatId, chatType: type, memberIds }];
  });
  const memberIds = [...new Set(normalized.flatMap((chat) => chat.memberIds))].sort();
  const displayNames = new Map<string, string | null>();
  // Locally set contact names (Contact.displayNameOverridden) from the same getContactsV2 response.
  const nicknames = new Map<string, string>();
  const picturePaths = new Map<string, string | null | undefined>();
  for (const batch of chunks(memberIds, CATALOG_BATCH_SIZE)) {
    const response = await invokeRead(() => talk.getContactsV2({ mids: batch }));
    if (!response.contacts || typeof response.contacts !== 'object' || Array.isArray(response.contacts)) continue;
    for (const [memberId, value] of Object.entries(response.contacts)) {
      const contact = value && typeof value === 'object' ? (value as { contact?: unknown }).contact : null;
      const displayName = contact && typeof contact === 'object'
        && typeof (contact as { displayName?: unknown }).displayName === 'string'
        ? (contact as { displayName: string }).displayName : null;
      displayNames.set(memberId, displayName);
      const nickname = contact && typeof contact === 'object'
        && typeof (contact as { displayNameOverridden?: unknown }).displayNameOverridden === 'string'
        ? (contact as { displayNameOverridden: string }).displayNameOverridden.slice(0, 256) : undefined;
      if (nickname !== undefined) nicknames.set(memberId, nickname);
      const hasPicturePath = Boolean(contact && typeof contact === 'object' && Object.hasOwn(contact, 'picturePath'));
      picturePaths.set(memberId, normalizeLinePicturePath(
        contact && typeof contact === 'object' ? (contact as { picturePath?: unknown }).picturePath : undefined,
        hasPicturePath,
      ));
    }
  }
  return normalized.map(({ raw, chatId, chatType: type, memberIds: ids }) => {
    const members = ids.map((memberId) => {
      const picturePath = picturePaths.get(memberId);
      const nickname = nicknames.get(memberId);
      return { memberId, displayName: displayNames.get(memberId) ?? null,
        ...(nickname === undefined ? {} : { nickname }),
        ...(picturePath === undefined ? {} : { picturePath }) };
    });
    const rawTitle = typeof raw.chatName === 'string' && raw.chatName.length > 0 ? raw.chatName : null;
    // Direct title rule shared with the native reader: the owner's nickname wins over the profile name.
    const title = type === 'direct' ? (nicknames.get(chatId) || null) ?? displayNames.get(chatId) ?? rawTitle : rawTitle;
    const picturePath = type === 'direct'
      ? picturePaths.get(chatId)
      : normalizeLinePicturePath(raw.picturePath, Object.hasOwn(raw, 'picturePath'));
    return { chatType: type, chatId, title, members,
      ...(picturePath === undefined ? {} : { picturePath }) };
  });
}

export async function decryptLinejsHistoryMessages(
  messages: readonly unknown[],
  decrypt: (message: unknown) => Promise<unknown>,
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const message of messages) {
    const metadata = message && typeof message === 'object'
      ? (message as { contentMetadata?: unknown }).contentMetadata : null;
    const encrypted = metadata && typeof metadata === 'object'
      && Boolean((metadata as { e2eeVersion?: unknown }).e2eeVersion);
    result.push(encrypted ? await decrypt(message) : message);
  }
  return result;
}

export function linejsEncryptedTextMessageOptions(to: string, chunks: Buffer[], replyToMessageId: string | null,
  mentions: readonly OutgoingMention[] = []): {
  to: string; contentType: 'NONE'; contentMetadata: Record<string, string>;
  relatedMessageId?: string; e2ee: true; chunks: Buffer[];
} {
  return { to, contentType: 'NONE', contentMetadata: { e2eeVersion: '2', contentType: '0', e2eeMark: '2',
      ...(mentions.length > 0 ? { MENTION: buildMentionContentMetadata(mentions) } : {}) },
    ...(replyToMessageId === null ? {} : { relatedMessageId: replyToMessageId }), e2ee: true, chunks };
}

class RotatingMemoryStorage extends MemoryStorage {
  #emit?: (snapshot: JsonValue) => void;
  #loading = false;
  #suppressEvents = false;
  setListener(listener: (snapshot: JsonValue) => void): void { this.#emit = listener; }
  async suppressEvents<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#suppressEvents;
    this.#suppressEvents = true;
    try { return await operation(); }
    finally { this.#suppressEvents = previous; }
  }
  async load(snapshot: JsonValue | null, qrCert: string | null): Promise<void> {
    this.#loading = true;
    try {
      await super.clear();
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        for (const [key, value] of Object.entries(snapshot)) await super.set(key, value as never);
      }
      if (qrCert !== null) await super.set('qrCert', qrCert);
    } finally { this.#loading = false; }
  }
  override async set(key: string, value: Parameters<MemoryStorage['set']>[1]): Promise<void> {
    await super.set(key, value);
    if (!this.#loading && !this.#suppressEvents) this.#emit?.(safeRaw(this.getAll()));
  }
  override async delete(key: string): Promise<void> {
    await super.delete(key);
    if (!this.#loading && !this.#suppressEvents) this.#emit?.(safeRaw(this.getAll()));
  }
  override async clear(): Promise<void> {
    await super.clear();
    if (!this.#loading && !this.#suppressEvents) this.#emit?.(safeRaw(this.getAll()));
  }
}

type ChatResourceReadValue = {
  nextCursor?: string | null; notes?: readonly unknown[]; note?: unknown; albums?: readonly unknown[];
  photos?: readonly unknown[]; photoPageShape?: { rawPhotoCount: number; hasMorePresent: boolean; hasMore?: boolean;
    nextCursorRelation: 'absent' | 'same' | 'advanced' }; bytes?: Uint8Array;
};

export class LinejsAdapter implements LineTransport {
  readonly #base: BaseClient;
  readonly #storage: RotatingMemoryStorage;
  readonly #options: LinejsAdapterOptions;
  readonly #gate: ReturnType<typeof createMutationGate<OpaqueCall, unknown, Response>>;
  readonly #listeners: Partial<Record<'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated' | 'refreshFailure', (value?: any) => void>> = {};
  readonly #directFetchContext = new AsyncLocalStorage<DirectFetchEffect>();
  readonly #chatResourceFetchContext = new AsyncLocalStorage<ChatResourceFetchEffect>();
  readonly #attachmentDownloadContext = new AsyncLocalStorage<AttachmentDownloadContext>();
  readonly #mediaUploadContext = new AsyncLocalStorage<MediaUploadScope>();
  readonly #serverLogoutContext = new AsyncLocalStorage<ServerLogoutContext>();
  readonly #requestFailures = new WeakSet<object>();
  #revoked = false;
  #refreshingCredentials = false;
  #refreshInFlight: Promise<void> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimerGeneration = 0;
  #tokenScheduleActive = true;
  #serverLogoutStarted = false;
  #downloadAuthAdopted = false;
  #adoptedObsToken: string | null = null;
  #activeRelationAdd: RelationAddContext | undefined;
  readonly #seenConversationIds = new Set<string>();

  private constructor(options: LinejsAdapterOptions) {
    this.#options = options;
    this.#storage = new RotatingMemoryStorage();
    const dispatchContext = new AsyncLocalStorage<TrustedInvocationDispatch<unknown, Response>>();
    const sourceContext = new AsyncLocalStorage<SourceCall>();
    let base!: BaseClient;
    const requestClient: TrustedRequestClient<OpaqueCall, unknown, Response> = {
      invoke: (call, dispatch) => dispatchContext.run(dispatch, call),
    };
    const appVersion = options.application?.split('\t')[1];
    if (options.application && (!options.application.startsWith('DESKTOPWIN\t') || !appVersion || !/^\d+(?:\.\d+){1,4}$/.test(appVersion))) {
      throw new Error('official desktop application version is invalid');
    }
    base = new BaseClient({ device: 'DESKTOPWIN', ...(appVersion ? { version: appVersion } : {}), storage: this.#storage, legy: { encrypted: 'auto' },
      fetch: async (request: Request) => {
        const source = sourceContext.getStore();
        const dispatch = dispatchContext.getStore();
        if (!source || !dispatch) {
          const serverLogout = this.#serverLogoutContext.getStore();
          if (serverLogout) {
            const response = await this.#gate.runServerLogout(request, serverLogout.permit, serverLogout.signal);
            await this.#validateServerLogoutResponse(response, serverLogout.signal);
            return response;
          }
          const upload = this.#mediaUploadContext.getStore();
          if (upload) {
            // linejs appends "/r/..." to a prefix that already ends in "/", so the path arrives as "//r/...".
            const url = new URL(request.url);
            url.pathname = url.pathname.replace(/^\/{2,}/, '/');
            // Read the body first. A stream body makes fetch use chunked Transfer-Encoding without
            // Content-Length, and the OBS server then answers HTTP 411. A buffered body gives Content-Length.
            const body = await request.arrayBuffer();
            const bounded = new Request(url, { method: request.method, headers: request.headers,
              body, redirect: 'error', signal: request.signal });
            const response = await this.#gate.runMediaUpload(upload, bounded);
            if (!response.ok) throw new ObsUploadHttpError(response.status);
            return response;
          }
          const direct = this.#directFetchContext.getStore();
          const resource = this.#chatResourceFetchContext.getStore();
          if (resource) {
            const bounded = new Request(request, { signal: resource.signal, redirect: 'error' });
            const response = await this.#gate.runChatResourceFetch(resource, bounded);
            return limitDownloadResponse(response, resource.maxBytes);
          }
          if (direct) {
            const download = this.#attachmentDownloadContext.getStore();
            const boundedRequest = download ? new Request(request, { signal: download.signal }) : request;
            const response = await this.#gate.runFetch(direct, boundedRequest);
            return download ? limitDownloadResponse(response, download.maxBytes) : response;
          }
          throw new EffectDeniedError('fetch is outside RequestClient invocation');
        }
        const token = base.authToken;
        const talk = source.path === '/S4' || source.path === '/SYNC4';
        const transport: RpcTransportState = !token
          ? { mode: 'direct', tokenState: 'none' }
          : !isV3Jwt(token)
            ? this.#downloadAuthAdopted
              ? { mode: 'direct', tokenState: 'legacy-opaque' }
              : { mode: 'unsupported', tokenState: 'legacy-opaque' }
            : talk ? { mode: 'legy-encrypted', tokenState: 'v3-jwt' }
              : { mode: 'direct', tokenState: 'v3-jwt' };
        // For direct requests this is the actual Request object constructed by
        // LINEJS. For LEGY requests the pinned RequestClient serializer creates
        // the logical Request before its encrypted transform.
        const headers = Object.fromEntries(Object.entries({ ...base.request.getHeader('POST'), ...source.headers })
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const logicalRequest = transport.mode === 'legy-encrypted'
          ? new Request(`https://${base.request.endpoint}${source.path}`, { method: 'POST',
            headers,
            body: new Uint8Array(base.thrift.writeThrift(source.value, source.methodName, Protocols[source.protocolType ?? 3])) })
          : request;
        const download = this.#attachmentDownloadContext.getStore();
        const resource = this.#chatResourceFetchContext.getStore();
        const resourceBootstrap = resource && source.path === '/CH4' ? resource : undefined;
        const dispatchedRequest = download ? new Request(request, { signal: download.signal }) : request;
        return await dispatch({ actualMethodName: source.methodName, actualPath: source.path,
          actualValue: source.value, transport, logicalRequest, execute: async (customFetch) => {
            const response = await customFetch(dispatchedRequest);
            if (download) return limitDownloadResponse(response, download.maxBytes);
            return resourceBootstrap ? limitChatResourceBootstrapResponse(response, resourceBootstrap.maxBytes) : response;
          } }) as Response;
      },
    });
    this.#base = base;
    const nativeRefresh = base.auth.tryRefreshToken.bind(base.auth);
    base.auth.tryRefreshToken = async () => {
      const source = sourceContext.getStore();
      if (source && !isReadOnlyRpc(source.path, source.methodName)) {
        throw new EffectDeniedError('native token refresh is denied for a non-read RPC to prevent mutation replay');
      }
      if (this.#serverLogoutStarted && !this.#refreshInFlight) {
        throw new EffectDeniedError('token refresh is paused during server logout');
      }
      let inFlight = this.#refreshInFlight;
      if (!inFlight) {
        const generation = this.#refreshTimerGeneration;
        inFlight = (async () => {
          this.#refreshingCredentials = true;
          try {
            await this.#gate.invokeRpc({ phase: 'AUTH_BOOTSTRAP' },
              () => this.#storage.suppressEvents(nativeRefresh));
            if (!this.#tokenScheduleActive || this.#revoked || generation !== this.#refreshTimerGeneration) return;
            const token = this.#base.authToken;
            if (!token) throw new Error('LINEJS refresh returned no access token');
            this.#listeners.credentials?.({ token, e2eeStorage: safeRaw(this.#storage.getAll()) });
            void this.#scheduleTokenRefresh();
          } finally { this.#refreshingCredentials = false; }
        })();
        this.#refreshInFlight = inFlight;
      }
      try { await inFlight; }
      finally { if (this.#refreshInFlight === inFlight) this.#refreshInFlight = undefined; }
    };
    if (options.application) base.request.systemType = options.application;
    const original = base.request.request.bind(base.request);
    base.request.request = (async (...args: Parameters<typeof original>) => {
      const [value, methodName, protocolType = 3, _parse = true, path = '/S3', headers = {}] = args;
      if (!dispatchContext.getStore()) throw new EffectDeniedError('RequestClient call is outside effect phase');
      // The traffic log reads this label when undici creates the request. It only observes.
      return trafficLabel.run(methodName, () => sourceContext.run({ value, methodName, path, protocolType, headers }, async () => {
        try { return await original(...args); }
        catch (error) {
          if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
            this.#requestFailures.add(error as object);
          }
          if (isTalkAuthInvalidation(error, path, methodName, protocolType)
            || (path === '/EXT/auth/tokenrefresh/v1' && isNotAuthorizedDeviceRequestError(error))) {
            this.#cancelTokenRefresh(true);
            this.#listeners.authInvalidated?.();
          }
          const rejection = decodeLinejsServerRejection(error, path, methodName, protocolType);
          if (rejection) {
            this.#requestFailures.add(rejection);
            throw rejection;
          }
          throw error;
        }
      }));
    }) as typeof base.request.request;
    this.#gate = createMutationGate({ accountId: options.accountId, workerInstanceId: options.workerInstanceId, controlEpoch: options.controlEpoch,
      requestClient, physicalTransport: async (request) => {
        const source = sourceContext.getStore();
        if (source?.path === '/RE4' && source.methodName === 'addFriendByMid' && this.#activeRelationAdd) {
          const active = this.#activeRelationAdd;
          if (active.consumed || active.signal.aborted || this.#revoked || this.#options.mode !== 'ACTIVE_CONTROL') {
            throw new EffectDeniedError('Relation add physical effect is no longer available');
          }
          // Consume before invoking callbacks/transport: any re-entrant or
          // second LINEJS dispatch is denied before it can reach the network.
          active.consumed = true;
          active.onPhysicalStart();
        }
        return await options.physicalTransport(request);
      },
      validateControlLease: async (lease, phase: ControlLeasePhase) => {
        const identityMatches = lease.accountId === options.accountId &&
          lease.workerInstanceId === options.workerInstanceId && lease.controlEpoch === options.controlEpoch;
        if (!identityMatches) return false;
        // Read-only reads survive write revocation. Physical sends must still
        // own their current grant after asynchronous preparation completes.
        if (phase === 'CONTROL_READ') {
          if (this.#revoked || options.mode !== 'ACTIVE_CONTROL') return true;
          return await options.validateLease(lease);
        }
        if (this.#revoked || options.mode === 'PAUSED'
          || (phase === 'CONTROL_SEND' && options.mode !== 'ACTIVE_CONTROL')) return false;
        const valid = await options.validateLease(lease);
        return valid && !this.#revoked
          && (phase === 'MANUAL_SEND' || options.mode === 'ACTIVE_CONTROL');
      },
    });
    base.on('qrcall', (code) => this.#listeners.qr?.(code));
    base.on('pincall', (pin) => this.#listeners.pin?.(pin));
    base.on('update:authtoken', (token) => {
      base.authToken = token;
      this.#clearChatResourceTokens();
      if (!this.#refreshingCredentials) this.#listeners.token?.(token);
    });
    base.on('update:qrcert', (qrCert) => this.#listeners.qrCert?.(qrCert));
    this.#storage.setListener((snapshot) => {
      this.#listeners.storage?.(snapshot);
      void this.#scheduleTokenRefresh();
    });
  }

  static async create(options: LinejsAdapterOptions): Promise<LinejsAdapter> {
    const root = options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.resolve('@evex/linejs/base'))), '..');
    const verified = await verifyLinejsPackage(root);
    if (verified.status !== 'verified') throw new ProtocolUnverifiedError(verified.reason);
    return new LinejsAdapter(options);
  }
  on(event: 'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated' | 'refreshFailure', listener: (value?: any) => void): void {
    this.#listeners[event] = listener;
  }
  async installSecrets(secrets: { token: string | null; qrCert: string | null; e2eeStorage: JsonValue | null }): Promise<void> {
    this.#downloadAuthAdopted = false;
    this.#adoptedObsToken = null;
    this.#clearChatResourceTokens();
    await this.#storage.load(secrets.e2eeStorage, secrets.qrCert);
    if (secrets.token === null) delete this.#base.authToken;
    else this.#base.authToken = secrets.token;
    await this.#scheduleTokenRefresh();
  }
  async loginQr(): Promise<TransportIdentity> {
    this.#downloadAuthAdopted = false;
    this.#adoptedObsToken = null;
    await this.#gate.invokeRpc({ phase: 'AUTH_BOOTSTRAP' }, () => this.#base.loginProcess.login({ qr: true, v3: true }));
    await this.#scheduleTokenRefresh();
    return this.#profile();
  }
  async loginToken(token: string): Promise<TransportIdentity> {
    this.#downloadAuthAdopted = false;
    this.#adoptedObsToken = null;
    const expire = await this.#storage.get('expire');
    const refreshToken = await this.#storage.get('refreshToken');
    let tokenToUse = token;
    if (typeof expire === 'number' && Number.isFinite(expire) && expire <= Math.floor(Date.now() / 1000)
      && typeof refreshToken === 'string') {
      await this.#base.auth.tryRefreshToken();
      const refreshedToken = this.#base.authToken;
      if (!refreshedToken) throw new Error('LINEJS refresh returned no access token');
      tokenToUse = refreshedToken;
    }
    await this.#gate.invokeRpc({ phase: 'AUTH_BOOTSTRAP' }, () => this.#base.loginProcess.login({ authToken: tokenToUse }));
    await this.#scheduleTokenRefresh();
    return this.#profile();
  }
  async #validateServerLogoutResponse(response: Response, signal: AbortSignal): Promise<void> {
    let parsed: ReturnType<BaseClient['thrift']['readThrift']>;
    try {
      const bytes = new Uint8Array(await abortable(response.clone().arrayBuffer(), signal));
      parsed = this.#base.thrift.readThrift(bytes, Protocols[4]!);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('LINE_LOGOUT_MALFORMED_RESPONSE');
    }
    if (parsed._info.fname !== 'logoutZ' || parsed._info.mtype !== 2
      || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      throw new Error('LINE_LOGOUT_MALFORMED_RESPONSE');
    }
    const fields = parsed.data as Record<string, unknown>;
    const responseFieldIds = Object.keys(fields);
    if (responseFieldIds.length === 0) {
      if (!response.ok) throw new Error('LINE_LOGOUT_SERVER_REJECTED');
      return;
    }
    const exception = fields['1'];
    if (responseFieldIds.length !== 1 || !exception || typeof exception !== 'object' || Array.isArray(exception)) {
      throw new Error('LINE_LOGOUT_MALFORMED_RESPONSE');
    }
    const code = (exception as Record<string, unknown>)['1'];
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new Error('LINE_LOGOUT_MALFORMED_RESPONSE');
    const errorName = Object.entries(TALK_SERVER_ERRORS).find(([, [upstreamCode]]) => upstreamCode === code)?.[0];
    if (errorName === 'AUTHENTICATION_FAILED' || errorName === 'NOT_AVAILABLE_USER' || errorName === 'NOT_AUTHORIZED_DEVICE') {
      throw new InternalError('RequestError', 'LINE authentication was invalidated during logout', { code: errorName });
    }
    throw new Error('LINE_LOGOUT_SERVER_REJECTED');
  }

  async logoutServer(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('LINE server logout aborted');
    if (this.#serverLogoutStarted) throw new EffectDeniedError('server logout already started');
    this.#serverLogoutStarted = true;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    try {
      const refreshInFlight = this.#refreshInFlight;
      if (refreshInFlight) await abortable(refreshInFlight.catch(() => undefined), signal);
      if (!this.#tokenScheduleActive || this.#revoked) return;
      const token = this.#base.authToken;
      if (typeof token !== 'string' || token.length === 0) throw new Error('LINE_LOGOUT_NO_TOKEN');
      const permit = this.#gate.createServerLogoutPermit(token);
      await this.#serverLogoutContext.run({ permit, signal }, () => this.#base.auth.logoutZ());
      this.#cancelTokenRefresh(true);
    } catch (error) {
      if (isExplicitAuthInvalidation(error)) {
        this.#cancelTokenRefresh(true);
        this.#listeners.authInvalidated?.();
        return;
      }
      this.#serverLogoutStarted = false;
      // An aborted wait leaves the refresh running. Its completion will persist
      // the rotated credentials and schedule from their new expiry exactly once.
      if (!this.#refreshInFlight) await this.#scheduleTokenRefresh();
      throw error;
    }
  }
  async #scheduleTokenRefresh(): Promise<void> {
    if (!this.#tokenScheduleActive || this.#revoked) return;
    const generation = ++this.#refreshTimerGeneration;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    if (this.#serverLogoutStarted) return;
    try {
      const [expire, refreshToken] = await Promise.all([this.#storage.get('expire'), this.#storage.get('refreshToken')]);
      if (!this.#tokenScheduleActive || this.#revoked || generation !== this.#refreshTimerGeneration || this.#serverLogoutStarted
        || typeof expire !== 'number' || !Number.isFinite(expire) || typeof refreshToken !== 'string' || !refreshToken) return;
      const earlyBoundaryMs = Math.random() * 1000;
      const delayMs = Math.max(0, expire * 1000 - Date.now() - earlyBoundaryMs);
      this.#refreshTimer = setTimeout(() => {
        if (!this.#tokenScheduleActive || this.#revoked || generation !== this.#refreshTimerGeneration || this.#serverLogoutStarted) return;
        this.#refreshTimer = undefined;
        void this.#base.auth.tryRefreshToken().catch(() => {
          if (this.#tokenScheduleActive && !this.#revoked) this.#listeners.refreshFailure?.({ code: 'LINE_TOKEN_REFRESH_FAILED' });
        });
      }, Math.min(delayMs, 2_147_000_000));
      this.#refreshTimer.unref?.();
    } catch { /* Missing or unreadable stored auth does not invalidate a usable session. */ }
  }
  #cancelTokenRefresh(deactivate = false): void {
    if (deactivate) this.#tokenScheduleActive = false;
    this.#refreshTimerGeneration += 1;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }
  async adoptDownloadAuth(token: string, application: string,
    options?: Readonly<{ expectedMid?: string; probe?: DownloadAuthProbe; signal?: AbortSignal }>): Promise<TransportIdentity> {
    const version = application.split('\t')[1];
    if (!application.startsWith('DESKTOPWIN\t') || !version || !/^\d+(?:\.\d+){1,4}$/.test(version)) {
      throw new Error('official desktop application version does not match worker');
    }
    const jwtMids = extractJwtUserMids(token);
    if (jwtMids.length > 0 && options?.expectedMid && !jwtMids.includes(options.expectedMid.toLowerCase())) {
      return { ownMid: jwtMids[0]!, displayName: null };
    }
    const probe = options?.probe;
    if (!probe) throw new Error('download auth probe is required');
    const ownMid = options?.expectedMid ?? jwtMids[0] ?? '';
    // Size-neutral validation: preflight never reads the body, so the download byte cap must not gate adoption.
    const validationMaxBytes = Number.MAX_SAFE_INTEGER - 64;
    const identity: AttachmentDownloadIdentity = {
      accountId: this.#options.accountId,
      chatType: probe.chatType,
      chatId: probe.chatId,
      ownMid,
      messageId: probe.messageId,
      kind: probe.kind,
      externalAttachmentId: probe.externalAttachmentId,
    };
    const parsed = probe.nativeAttachment
      ? validateNativeAttachment(probe.nativeAttachment, identity, validationMaxBytes)
      : validateAttachmentMessage(probe.lineMessage, identity, validationMaxBytes);
    const signal = options?.signal ?? new AbortController().signal;
    const context = { phase: 'MONITOR_READ' as const };
    this.#base.authToken = token;
    this.#base.request.systemType = application;
    this.#base.request.userAgent = `Line/${version}`;
    this.#downloadAuthAdopted = true;
    this.#adoptedObsToken = null;
    try {
      return await this.#attachmentDownloadContext.run({ signal, maxBytes: DOWNLOAD_AUTH_PREFLIGHT_MAX_BYTES }, async () =>
        await this.#directFetchContext.run(context, async () => {
          const path = `/r/talk/${parsed.sid}/${parsed.oid}`;
          const talkMeta = parsed.encrypted ? attachmentTalkMeta(identity.messageId) : null;
          if (!isV3Jwt(token)) {
            let directObsToken: string | null = null;
            try {
              directObsToken = token.includes('\u001e') ? parseEncryptedAccessToken(token) : token;
            } catch { directObsToken = null; }
            if (directObsToken && /^[\x21-\x7e]+$/.test(directObsToken)) {
              try {
                await preflightAttachment(this.#gate, context, {
                  path, headers: attachmentHeaders(this.#base, directObsToken, talkMeta), obsPop: parsed.obsPop, signal,
                });
                this.#adoptedObsToken = directObsToken;
                return { ownMid, displayName: null };
              } catch (error) {
                if (!(error instanceof SafeAttachmentError)
                  || (error.code !== 'LINE_OBS_HTTP_401' && error.code !== 'LINE_OBS_HTTP_403')) {
                  throw error;
                }
              }
            }
          }
          let rawToken: unknown;
          try {
            rawToken = await this.#gate.invokeRpc({ ...context, allowLegacyOpaqueDirect: true },
              () => this.#base.talk.acquireEncryptedAccessToken({ featureType: 2 }));
          } catch (error) {
            throw classifyAttachmentRpcPhase(error, 'LINE_OBS_TOKEN_RPC_FAILED',
              this.#requestFailures.has(error as object));
          }
          const obsToken = parseEncryptedAccessToken(rawToken);
          await preflightAttachment(this.#gate, context, {
            path, headers: attachmentHeaders(this.#base, obsToken, talkMeta), obsPop: parsed.obsPop, signal,
          });
          this.#adoptedObsToken = obsToken;
          return { ownMid, displayName: null };
        }));
    } catch (error) {
      this.#downloadAuthAdopted = false;
      this.#adoptedObsToken = null;
      delete this.#base.authToken;
      throw error;
    }
  }
  clearDownloadAuth(): void {
    this.#downloadAuthAdopted = false;
    this.#adoptedObsToken = null;
    delete this.#base.authToken;
  }
  async listConversations(): Promise<readonly ConversationCatalogItem[]> {
    const context = this.#readContext();
    return fetchLinejsConversationCatalog({
      ownMid: this.#profile().ownMid,
      getAllChatMids: (options) => this.#base.talk.getAllChatMids(options),
      getMessageBoxes: (options) => this.#base.talk.getMessageBoxes(options),
      getChats: (options) => this.#base.talk.getChats(options),
      getContactsV2: (options) => this.#base.talk.getContactsV2(options),
    }, async (call) => await this.#gate.invokeRpc(context, call) as Awaited<ReturnType<typeof call>>);
  }
  async refreshOwnProfile(): Promise<TransportIdentity> {
    if (this.#downloadAuthAdopted || this.#revoked || !this.#base.authToken) throw new Error('LINE profile read is unavailable');
    const profile = await this.#gate.invokeRpc(this.#readContext(), () => this.#base.talk.getProfile()) as {
      mid?: unknown; displayName?: unknown; picturePath?: unknown;
    };
    if (!profile || typeof profile.mid !== 'string' || !/^u[0-9a-f]{32}$/i.test(profile.mid)) throw new Error('LINE profile response is invalid');
    const picturePath = normalizeLinePicturePath(profile.picturePath, Object.hasOwn(profile, 'picturePath'));
    const displayName = typeof profile.displayName === 'string' && profile.displayName.length <= 256 ? profile.displayName : null;
    return { ownMid: profile.mid.toLowerCase(), displayName,
      ...(picturePath === undefined ? {} : { picturePath }) };
  }
  #profile(): TransportIdentity {
    const profile = this.#base.profile;
    if (!profile?.mid) throw new Error('LINEJS login returned no profile MID');
    const raw = profile as typeof profile & { picturePath?: unknown };
    const picturePath = normalizeLinePicturePath(raw.picturePath, Object.hasOwn(raw, 'picturePath'));
    return { ownMid: profile.mid, displayName: profile.displayName ?? null,
      ...(picturePath === undefined ? {} : { picturePath }) };
  }
  async sync(cursor: TalkCursorV1Dto): Promise<SyncResult> {
    const context = this.#readContext();
    const response = await this.#gate.invokeRpc(context, () => this.#base.talk.sync({
      revision: BigInt(cursor.revision), globalRev: BigInt(cursor.globalRev),
      individualRev: BigInt(cursor.individualRev), limit: 100,
    })) as Awaited<ReturnType<BaseClient['talk']['sync']>>;
    let revision = cursor.revision;
    let globalRev = cursor.globalRev;
    let individualRev = cursor.individualRev;
    revision = decimal(response.fullSyncResponse?.nextRevision, revision);
    globalRev = decimal(response.operationResponse?.globalEvents?.lastRevision, globalRev);
    individualRev = decimal(response.operationResponse?.individualEvents?.lastRevision, individualRev);
    const operations = [] as SyncResult['operations'] extends readonly (infer T)[] ? T[] : never[];
    const catchupChatIds: string[] = [];
    const receipts = new Map<string, { chatId: string; readerMid: string; messageId: bigint; createdTime: number }>();
    for (const operation of response.operationResponse?.operations ?? []) {
      revision = decimal(operation.revision, revision);
      if (operation.message) {
        try {
          const message = await this.#gate.invokeRpc(context, () => this.#base.e2ee.decryptE2EEMessage(operation.message!)) as { id?: unknown; from?: unknown; to?: unknown };
          operations.push({ ...operation, message });
          const from = typeof message.from === 'string' ? message.from : null;
          const to = typeof message.to === 'string' ? message.to : null;
          const ownMid = this.#base.profile?.mid;
          const chatId = to === ownMid ? from : to;
          if (chatId) this.#seenConversationIds.add(chatId);
        } catch (error) {
          operations.push({ operation, decryptionError: {
            code: error instanceof EffectDeniedError ? 'SIDE_EFFECT_DENIED' : 'MISSING_E2EE_KEY', retryable: false,
          } });
        }
      } else {
        const value = operation as unknown as { type?: unknown; param1?: unknown; param2?: unknown; param3?: unknown; createdTime?: unknown };
        if (value.type === 'NOTIFIED_READ_MESSAGE') this.#collectReadReceipt(value, receipts);
        if (value.type === 'NOTIFIED_READ_MESSAGE' && typeof value.param1 === 'string'
          && /^[ucr]/.test(value.param1) && !this.#seenConversationIds.has(value.param1)) {
          this.#seenConversationIds.add(value.param1);
          catchupChatIds.push(value.param1);
        }
      }
    }
    // A first sync may jump directly to the current revision. A read receipt can
    // therefore be the first sighting of a conversation even though its message
    // predates login. Recover recent messages once, without rendering the receipt.
    for (const chatId of catchupChatIds.slice(0, 5)) {
      try {
        const recent = await this.#gate.invokeRpc(context, () => this.#base.talk.getRecentMessagesV2({ messageBoxId: chatId, messagesCount: 20 })) as readonly unknown[];
        for (const encrypted of [...recent].reverse()) {
          try {
            const message = await this.#gate.invokeRpc(context, () => this.#base.e2ee.decryptE2EEMessage(encrypted as Parameters<BaseClient['e2ee']['decryptE2EEMessage']>[0])) as { id?: unknown };
            operations.push({ source: 'history', operation: { revision: message.id, message } });
          } catch { /* Keep polling; unavailable E2EE history is not a fake message. */ }
        }
      } catch {
        this.#seenConversationIds.delete(chatId);
      }
    }
    const readReceipts = [...receipts.values()].map((receipt) => ({
      chatId: receipt.chatId, readerMid: receipt.readerMid, messageId: receipt.messageId.toString(),
      readAt: new Date(receipt.createdTime).toISOString(),
    }));
    return { cursorAfter: { version: 1, revision, globalRev, individualRev }, operations,
      ...(readReceipts.length === 0 ? {} : { readReceipts }) };
  }
  /** In-memory drop counters for NOTIFIED_READ_MESSAGE ops (no event type carries them). */
  readonly #readReceiptCounters = { readReceiptShapeDropped: 0, readReceiptOverflowDropped: 0 };
  get readReceiptCounters(): Readonly<{ readReceiptShapeDropped: number; readReceiptOverflowDropped: number }> {
    return { ...this.#readReceiptCounters };
  }
  #collectReadReceipt(value: { param1?: unknown; param2?: unknown; param3?: unknown; createdTime?: unknown },
    receipts: Map<string, { chatId: string; readerMid: string; messageId: bigint; createdTime: number }>): void {
    const createdTime = typeof value.createdTime === 'bigint' ? Number(value.createdTime)
      : typeof value.createdTime === 'string' && /^[0-9]{1,15}$/.test(value.createdTime) ? Number(value.createdTime)
        : value.createdTime;
    const param3 = typeof value.param3 === 'bigint' ? value.param3.toString() : value.param3;
    if (typeof value.param1 !== 'string' || !/^[ucr][0-9a-f]{32}$/.test(value.param1)
      || typeof value.param2 !== 'string' || !/^u[0-9a-f]{32}$/.test(value.param2)
      || typeof param3 !== 'string' || !/^[0-9]{1,20}$/.test(param3)
      || typeof createdTime !== 'number' || !Number.isSafeInteger(createdTime) || createdTime <= 0
      || Number.isNaN(new Date(createdTime).getTime())) {
      this.#readReceiptCounters.readReceiptShapeDropped += 1;
      return;
    }
    if (value.param2 === this.#base.profile?.mid) return;
    const key = `${value.param1}|${value.param2}`;
    const messageId = BigInt(param3);
    const existing = receipts.get(key);
    if (existing) {
      if (messageId > existing.messageId) receipts.set(key, { ...existing, messageId, createdTime });
      return;
    }
    if (receipts.size >= 500) { this.#readReceiptCounters.readReceiptOverflowDropped += 1; return; }
    receipts.set(key, { chatId: value.param1, readerMid: value.param2, messageId, createdTime });
  }
  async history(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string },
    cursor: HistoryCursorV1 | null, limit: number): Promise<readonly unknown[]> {
    if (cursor && (cursor.accountId !== this.#options.accountId || cursor.chatType !== conversation.chatType ||
      cursor.chatId !== conversation.chatId)) throw new EffectDeniedError('history cursor conversation mismatch');
    const context = this.#readContext();
    const messages = cursor === null
      ? await this.#gate.invokeRpc(context, () => this.#base.talk.getRecentMessagesV2({
        messageBoxId: conversation.chatId, messagesCount: limit,
      })) as readonly unknown[]
      : await this.#gate.invokeRpc(context, () => this.#base.talk.getPreviousMessagesV2WithRequest({
        request: { messageBoxId: conversation.chatId, messagesCount: limit,
          endMessageId: { messageId: BigInt(cursor.messageId), deliveredTime: BigInt(cursor.deliveredTime) } },
      })) as readonly unknown[];
    return decryptLinejsHistoryMessages(messages, async (message) => await this.#gate.invokeRpc(context,
      () => this.#base.e2ee.decryptE2EEMessage(message as Parameters<BaseClient['e2ee']['decryptE2EEMessage']>[0])));
  }
  async readChatResource(command: ChatResourceReadCommand, options: Readonly<{ signal: AbortSignal }>): Promise<ChatResourceReadValue> {
    try { return await this.#readChatResourceOnce(command, options); }
    catch (error) {
      // A failed read may have used a stale cached channel token. Drop both so the next request bootstraps fresh ones,
      // as a restart would. Cancellation and local denial say nothing about token validity.
      if (!options.signal.aborted && !(error instanceof EffectDeniedError)) this.#clearChatResourceTokens();
      throw error;
    }
  }
  async #readChatResourceOnce(command: ChatResourceReadCommand, options: Readonly<{ signal: AbortSignal }>): Promise<ChatResourceReadValue> {
    if (!this.#base.authToken || !this.#base.profile?.mid) throw new EffectDeniedError('chat resources require a logged-in account');
    if (options.signal.aborted) throw options.signal.reason;
    const context = this.#readContext();
    const rest = { accountId: this.#options.accountId, workerInstanceId: this.#options.workerInstanceId,
      controlEpoch: this.#options.controlEpoch, signal: options.signal,
      maxBytes: command.action === 'downloadAlbumPhoto' ? command.maxBytes! : 2 * 1024 * 1024,
      chatId: command.chatId, ownMid: this.#base.profile.mid, action: command.action,
      ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
      ...(command.postId === undefined ? {} : { postId: command.postId }),
      ...(command.albumId === undefined ? {} : { albumId: command.albumId }),
      ...(command.oid === undefined ? {} : { oid: command.oid }), ...(command.prefix === undefined ? {} : { prefix: command.prefix }),
      ...(context.phase === 'CONTROL_READ' ? { lease: context.lease } : {}) };
    const withFetch = <T>(fn: () => Promise<T>) => this.#chatResourceFetchContext.run(rest, fn);
    const stage = async <T>(category: 'bootstrap_failure' | 'list_get_transport_failure' | 'normalization_failure', operation: () => Promise<T> | T): Promise<T> => {
      try { return await operation(); } catch (error) {
        if (options.signal.aborted) throw error;
        const fields = safeChatResourceFailureDetails(error);
        throw new ChatResourceFailure(category, undefined, fields.failureKind, fields.upstreamStatus, fields.upstreamCode);
      }
    };
    const listGet = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); } catch (error) {
        if (options.signal.aborted) throw error;
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
    if (command.action === 'listNotes' || command.action === 'getNote') {
      // LINEJS lazily obtains this channel token. Keep its sole Thrift bootstrap inside the exact RPC gate.
      await stage('bootstrap_failure', () => withFetch(() => this.#gate.invokeRpc({ phase: 'CHAT_RESOURCE_BOOTSTRAP', chatResourceBootstrap: {
        accountId: rest.accountId, workerInstanceId: rest.workerInstanceId, controlEpoch: rest.controlEpoch,
        channelId: '1341209850', signal: options.signal, maxBytes: 64 * 1024,
      } }, () => this.#base.timeline.initTimeline())));
      const response = await stage('list_get_transport_failure', () => withFetch(() => command.action === 'listNotes'
        ? this.#base.timeline.listPost({ homeId: command.chatId, ...(command.cursor ? { postId: command.cursor } : {}) })
        : this.#base.timeline.getPost({ homeId: command.chatId, postId: command.postId! })));
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatResourceFailure('response_shape_invalid');
      const raw = response as Record<string, unknown>;
      if (raw.code !== 0) throw new ChatResourceFailure('response_code_invalid', boundedChatResourceResponseCode(raw.code, Object.hasOwn(raw, 'code')));
      if (!raw.result || typeof raw.result !== 'object' || Array.isArray(raw.result)) throw new ChatResourceFailure('response_shape_invalid');
      const data = raw.result as Record<string, unknown>;
      const posts = Array.isArray(data.posts) ? data.posts : command.action === 'getNote' ? [data.post ?? data] : [];
      const notes = await stage('normalization_failure', () => posts.slice(0, command.limit ?? 50).map((post) => normalizeChatNote(post)));
      const next = data.nextCursor ?? data.nextPostId ?? data.cursor;
      return command.action === 'getNote' ? { note: notes[0] } : {
        notes, nextCursor: typeof next === 'string' && next.length <= 2048 ? next : null,
      };
    }
    // Moa's token bootstrap is likewise an exact /CH4 RPC; its service caches the token per account session.
    await stage('bootstrap_failure', () => withFetch(() => this.#gate.invokeRpc({ phase: 'CHAT_RESOURCE_BOOTSTRAP', chatResourceBootstrap: {
      accountId: rest.accountId, workerInstanceId: rest.workerInstanceId, controlEpoch: rest.controlEpoch,
      channelId: '1375220249', signal: options.signal, maxBytes: 64 * 1024,
    } }, () => this.#base.moa.getAlbumChannelToken())));
    if (command.action === 'listAlbums') {
      const response = await listGet(() => withFetch(() => this.#base.moa.getAlbums({ ...(command.cursor === undefined || command.cursor === null ? {} : { cursor: command.cursor }) })));
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatResourceFailure('response_shape_invalid');
      const albumResult = response.result;
      const albums = albumResult?.albums;
      if (!albumResult || !Array.isArray(albums)) throw new ChatResourceFailure('response_shape_invalid');
      return await stage('normalization_failure', () => ({ albums: albums.filter((album) => album.chatId === command.chatId).slice(0, command.limit ?? 50).map((album) => ({
        albumId: String(album.albumId), chatId: String(album.chatId), title: typeof album.title === 'string' ? album.title : null,
        photoCount: finiteNonnegative(album.photoCount), createTime: finiteNonnegative(album.createTime), updateTime: finiteNonnegative(album.updateTime),
      })), nextCursor: typeof albumResult.nextCursor === 'string' ? albumResult.nextCursor : albumResult.hasMore ? albumResult.cursor ?? null : null }));
    }
    if (command.action === 'listAlbumPhotos') {
      const response = await listGet(() => withFetch(() => this.#base.moa.getPhotos({ chatId: command.chatId, albumId: command.albumId!,
        ...(command.cursor === undefined || command.cursor === null ? {} : { cursor: command.cursor }), pageSize: command.limit ?? 50 })));
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatResourceFailure('response_shape_invalid');
      const photoResult = response.result;
      const photos = photoResult?.photos;
      if (!photoResult || !Array.isArray(photos)) throw new ChatResourceFailure('response_shape_invalid');
      const nativePhotoPage = photoResult as typeof photoResult & { hasMore?: boolean; cursor?: string };
      const hasMorePresent = Object.hasOwn(photoResult, 'hasMore');
      const hasMore = typeof nativePhotoPage.hasMore === 'boolean' ? nativePhotoPage.hasMore : undefined;
      const rawNextCursor = typeof photoResult.nextCursor === 'string' ? photoResult.nextCursor : null;
      const photoPageShape = { rawPhotoCount: photos.length, hasMorePresent, ...(hasMore === undefined ? {} : { hasMore }),
        nextCursorRelation: rawNextCursor === null ? 'absent' as const
          : rawNextCursor === (command.cursor ?? null) ? 'same' as const : 'advanced' as const };
      const nextCursor = nativePhotoPage.hasMore === false ? null : typeof photoResult.nextCursor === 'string' ? photoResult.nextCursor
        : nativePhotoPage.hasMore === true && typeof nativePhotoPage.cursor === 'string' ? nativePhotoPage.cursor : null;
      return await stage('normalization_failure', () => ({ photos: photos.slice(0, command.limit ?? 50).flatMap((photo) => {
        const oid = photo.oid ?? photo.obsResourceId?.oid;
        const photoId = photo.photoId ?? photo.id ?? oid;
        if (oid === undefined || photoId === undefined) return [];
        return [{ photoId: String(photoId), oid: String(oid), prefix: photo.obsResourceId?.sid === 'v' || photo.resourceType === 'VIDEO' ? 'album/v' as const : 'album/a' as const,
          shotTime: finiteNonnegative(photo.shotTime), width: finitePositive(photo.width), height: finitePositive(photo.height) }];
      }), nextCursor,
      photoPageShape }));
    }
    const bytes = await listGet(() => withFetch(() => this.#base.moa.downloadPhoto({ chatId: command.chatId, albumId: command.albumId!,
      oid: command.oid!, prefix: command.prefix! })));
    if (bytes.byteLength > command.maxBytes!) throw new ChatResourceFailure('response_validation');
    if (options.signal.aborted) throw options.signal.reason;
    return { bytes };
  }
  async download(_kind: 'image' | 'video' | 'audio' | 'file', _messageId: string,
    _externalAttachmentId: string, lineMessage: JsonValue,
    options: Readonly<{ signal: AbortSignal; maxBytes: number; identity: AttachmentDownloadIdentity;
      nativeAttachment?: NativeAttachmentDownloadInput }>): Promise<DownloadedAttachment> {
    if (!this.#base.authToken) throw new EffectDeniedError('OBS download requires login');
    const context = this.#readContext();
    try {
      const boundedContext = { signal: options.signal, maxBytes: options.maxBytes + 32 };
      return await this.#attachmentDownloadContext.run(boundedContext, async () => await this.#directFetchContext.run(context, async () => {
        const native = options.nativeAttachment;
        const nativeParsed = native ? validateNativeAttachment(native, options.identity, options.maxBytes) : null;
        const parsed = nativeParsed ?? validateAttachmentMessage(lineMessage, options.identity, options.maxBytes);
        let keyMaterial: Buffer | null = nativeParsed?.keyMaterial ?? null;
        let name: string | null = nativeParsed?.fileName ?? null;
        if (parsed.encrypted && !native) {
          let payload: Record<string, unknown>;
          try {
            payload = await this.#gate.invokeRpc(context, () => this.#base.e2ee.decryptE2EEDataMessage(
              parsed.message as unknown as Parameters<BaseClient['e2ee']['decryptE2EEDataMessage']>[0])) as Record<string, unknown>;
          } catch (error) { throw classifyAttachmentRpcPhase(error, 'LINE_E2EE_METADATA_RPC_FAILED',
            this.#requestFailures.has(error as object)); }
          if (typeof payload.keyMaterial !== 'string' || payload.keyMaterial.length > 256) throw new SafeAttachmentError('LINE_E2EE_KEY_MISMATCH');
          keyMaterial = Buffer.from(payload.keyMaterial, 'base64');
          if (keyMaterial.length !== 32 || keyMaterial.toString('base64') !== payload.keyMaterial) throw new SafeAttachmentError('LINE_E2EE_KEY_MISMATCH');
          if (typeof parsed.metadata.ENC_KM === 'string' && parsed.metadata.ENC_KM !== payload.keyMaterial) throw new SafeAttachmentError('LINE_E2EE_KEY_MISMATCH');
          if (typeof payload.fileName === 'string' && payload.fileName.length <= 255) name = payload.fileName;
        }
        const acquireObsToken = async (): Promise<string> => {
          let rawToken: unknown;
          try {
            rawToken = await this.#gate.invokeRpc({ ...context, ...(this.#downloadAuthAdopted ? { allowLegacyOpaqueDirect: true } : {}) },
              () => this.#base.talk.acquireEncryptedAccessToken({ featureType: 2 }));
          } catch (error) { throw classifyAttachmentRpcPhase(error, 'LINE_OBS_TOKEN_RPC_FAILED',
            this.#requestFailures.has(error as object)); }
          const nextToken = parseEncryptedAccessToken(rawToken);
          if (this.#downloadAuthAdopted) this.#adoptedObsToken = nextToken;
          return nextToken;
        };
        let usedCachedObsToken = this.#downloadAuthAdopted && this.#adoptedObsToken !== null;
        let token = usedCachedObsToken ? this.#adoptedObsToken! : await acquireObsToken();
        const talkMeta = parsed.encrypted ? attachmentTalkMeta(options.identity.messageId) : null;
        let headers = attachmentHeaders(this.#base, token, talkMeta);
        const path = `/r/talk/${parsed.sid}/${parsed.oid}`;
        for (let cycle = 0; cycle < 6; cycle += 1) {
          if (options.signal.aborted) throw options.signal.reason;
          let preflight: 'ready' | 'incomplete';
          try {
            preflight = await preflightAttachment(this.#gate, context,
              { path, headers, obsPop: parsed.obsPop, signal: options.signal });
          } catch (error) {
            if (usedCachedObsToken && error instanceof SafeAttachmentError
              && (error.code === 'LINE_OBS_HTTP_401' || error.code === 'LINE_OBS_HTTP_403')) {
              usedCachedObsToken = false;
              this.#adoptedObsToken = null;
              token = await acquireObsToken();
              headers = attachmentHeaders(this.#base, token, talkMeta);
              preflight = await preflightAttachment(this.#gate, context,
                { path, headers, obsPop: parsed.obsPop, signal: options.signal });
            } else {
              throw error;
            }
          }
          if (preflight === 'incomplete') {
            if (cycle === 5) throw new SafeAttachmentError('LINE_OBS_ENCODING_INCOMPLETE');
            await abortableAttachmentDelay(options.signal);
            continue;
          }
          const mediaPath = parsed.tid ? `${path}/original` : path;
          let response = await responseForObs(this.#gate, context, new Request(attachmentUrl(mediaPath, parsed.obsPop), {
            method: 'GET', headers, signal: options.signal, redirect: 'error',
          }));
          if (usedCachedObsToken && (response.status === 401 || response.status === 403)) {
            await cancelResponse(response);
            usedCachedObsToken = false;
            this.#adoptedObsToken = null;
            token = await acquireObsToken();
            headers = attachmentHeaders(this.#base, token, talkMeta);
            response = await responseForObs(this.#gate, context, new Request(attachmentUrl(mediaPath, parsed.obsPop), {
              method: 'GET', headers, signal: options.signal, redirect: 'error',
            }));
          }
          if (response.status === 202) {
            await cancelResponse(response);
            if (cycle === 5) throw new SafeAttachmentError('LINE_OBS_ENCODING_INCOMPLETE');
            await abortableAttachmentDelay(options.signal);
            continue;
          }
          if (response.status !== 200) { await cancelResponse(response); throw nativeHttpFailure(response.status); }
          const ciphertext = await readBoundedResponse(response, options.maxBytes + (parsed.encrypted ? 32 : 0), options.signal);
          let output = ciphertext;
          if (keyMaterial) output = options.identity.kind === 'video'
            ? await decryptVideo(this.#base.e2ee, ciphertext, keyMaterial)
            : await this.#base.e2ee.decryptByKeyMaterial(ciphertext, keyMaterial);
          if (output.length > options.maxBytes) throw new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
          return { name, source: singleAttachmentChunk(output) };
        }
        throw new SafeAttachmentError('LINE_OBS_ENCODING_INCOMPLETE');
      }));
    } catch (error) {
      if (options.signal.aborted) {
        const reason = options.signal.reason as { code?: unknown } | undefined;
        throw new SafeAttachmentError(reason?.code === 'TIMEOUT' ? 'LINE_DOWNLOAD_TIMEOUT' : 'LINE_DOWNLOAD_CANCELLED');
      }
      const safe = error instanceof SafeAttachmentError ? error : classifyNativeAttachmentFailure(error);
      if (safe.code === 'LINE_AUTH_INVALIDATED') {
        this.#cancelTokenRefresh(true);
        this.#listeners.authInvalidated?.();
      }
      throw safe;
    }
  }
  async send(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, text: string,
    replyToMessageId: string | null, lease: ControlLease, manual = false, mentions: readonly OutgoingMention[] = []): Promise<{ messageId: string }> {
    if ((this.#options.mode !== 'ACTIVE_CONTROL' && !(manual && this.#options.mode === 'MONITOR_ONLY')) || this.#revoked) throw new EffectDeniedError('worker mode is read-only');
    const prefix = { direct: 'u', group: 'c', room: 'r' }[conversation.chatType];
    if (!conversation.chatId.startsWith(prefix)) throw new EffectDeniedError('conversation type/MID mismatch');
    const chunks = await this.#gate.invokeRpc(manual ? { phase: 'MONITOR_READ' } : { phase: 'CONTROL_READ', lease },
      () => this.#base.e2ee.encryptE2EEMessage(conversation.chatId, text, 'NONE')) as Buffer[];
    const result = await this.#gate.invokeRpc(manual ? { phase: 'MANUAL_SEND', lease } : { phase: 'CONTROL_SEND', lease },
      () => this.#base.talk.sendMessage(linejsEncryptedTextMessageOptions(conversation.chatId, chunks, replyToMessageId, mentions))) as
      Awaited<ReturnType<BaseClient['talk']['sendMessage']>>;
    return { messageId: String(result.id) };
  }
  /** Mirrors linejs `obs.uploadMediaByE2EE`, with every POST and RPC passing the mutation gate. */
  async sendMedia(conversation: { chatType: 'direct' | 'group'; chatId: string },
    media: Readonly<{ kind: 'image' | 'file'; bytes: Buffer; fileName: string }>, lease: ControlLease, manual = false): Promise<{ messageId: string }> {
    if ((this.#options.mode !== 'ACTIVE_CONTROL' && !(manual && this.#options.mode === 'MONITOR_ONLY')) || this.#revoked) throw new EffectDeniedError('worker mode is read-only');
    const prefix = conversation.chatType === 'direct' ? 'u' : conversation.chatType === 'group' ? 'c' : undefined;
    if (prefix === undefined || !conversation.chatId.startsWith(prefix)) throw new EffectDeniedError('conversation type/MID mismatch');
    if (media.kind !== 'image' && media.kind !== 'file') throw new EffectDeniedError('unsupported media kind');
    const [namespace, contentType] = media.kind === 'image' ? ['emi', 1] as const : ['emf', 14] as const;
    const scope = this.#gate.openMediaUploadScope(lease, media.kind, manual);
    try {
      let prepared: { objId: string; size: number; chunks: Buffer[] };
      // The step that is running; a failure keeps it so the cause of an upload failure is known. The order of the steps is unchanged.
      let stage: MediaUploadStage = 'encrypt';
      try {
        const { keyMaterial, encryptedData } = await this.#base.e2ee.encryptByKeyMaterial(media.bytes);
        const encrypted = new Blob([new Uint8Array(encryptedData.buffer, encryptedData.byteOffset, encryptedData.byteLength) as never]);
        const params = { type: 'file' };
        const objId = await this.#mediaUploadContext.run(scope, async () => {
          stage = 'obs_upload';
          const first = await this.#base.obs.uploadObjectForService({ data: encrypted, oType: 'file',
            obsPath: `talk/${namespace}/reqid-${randomUUID()}`, params });
          if (first.objId === '') throw new Error('OBS object id missing');
          if (media.kind === 'image') {
            // No separate thumbnail: the preview is the same encrypted data, as linejs does without one.
            stage = 'obs_preview';
            const preview = await this.#base.obs.uploadObjectForService({ data: encrypted, oType: 'file',
              obsPath: `talk/${namespace}/${first.objId}__ud-preview`, params });
            if (preview.objId !== first.objId) throw new Error('OBS preview object id mismatch');
          }
          return first.objId;
        });
        stage = 'e2ee_message';
      const chunks = await this.#gate.invokeRpc({ phase: manual ? 'MONITOR_READ' : 'CONTROL_READ', lease }, () =>
          this.#base.e2ee.encryptE2EEMessage(conversation.chatId, { keyMaterial, fileName: media.fileName },
            contentType as never)) as Buffer[];
        prepared = { objId, size: encrypted.size, chunks };
      } catch (error) {
        if (error instanceof EffectDeniedError || isLineServerRejection(error)) throw tagMediaStage(error, stage);
        throw new MediaUploadFailedError(stage, error);
      }
      const extension = media.fileName.split('.').at(-1);
      const result = await this.#gate.invokeRpc({ phase: manual ? 'MANUAL_SEND' : 'CONTROL_SEND', lease }, () => this.#base.talk.sendMessage({
        to: conversation.chatId, chunks: prepared.chunks, contentType: contentType as never, e2ee: true,
        contentMetadata: {
          SID: namespace, OID: prepared.objId, FILE_SIZE: prepared.size.toString(), e2eeVersion: '2',
          ...(media.kind === 'image' ? { MEDIA_CONTENT_INFO: JSON.stringify({
            category: 'original', fileSize: prepared.size, extension, animated: false }) } : {}),
        },
      })) as Awaited<ReturnType<BaseClient['talk']['sendMessage']>>;
      return { messageId: String(result.id) };
    } finally { scope.close(); }
  }
  async react(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, messageId: string,
    reaction: Extract<import('@line-agent/contracts').LineWorkerCommand, { type: 'reactMessage' }>['reaction'],
    lease: ControlLease): Promise<void> {
    if (this.#options.mode !== 'ACTIVE_CONTROL' || this.#revoked) throw new EffectDeniedError('worker mode is read-only');
    const prefix = { direct: 'u', group: 'c', room: 'r' }[conversation.chatType];
    if (!conversation.chatId.startsWith(prefix)) throw new EffectDeniedError('conversation type/MID mismatch');
    if (!/^(?:0|[1-9][0-9]*)$/.test(messageId) || BigInt(messageId) > 9223372036854775807n) {
      throw new EffectDeniedError('message ID is not a LINE int64');
    }
    await this.#gate.invokeRpc({ phase: 'CONTROL_SEND', lease }, async () => {
      if (reaction === 'UNDO') {
        const reqSeq = await this.#base.getReqseq();
        return await this.#base.talk.cancelReaction({ cancelReactionRequest: { reqSeq, messageId: BigInt(messageId) } });
      }
      return await this.#base.talk.react({ id: BigInt(messageId), reaction });
    });
  }
  async unsend(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, messageId: string,
    lease: ControlLease): Promise<void> {
    if ((this.#options.mode !== 'ACTIVE_CONTROL' && this.#options.mode !== 'MONITOR_ONLY') || this.#revoked) {
      throw new EffectDeniedError('worker mode is read-only');
    }
    const prefix = { direct: 'u', group: 'c', room: 'r' }[conversation.chatType];
    if (!conversation.chatId.startsWith(prefix)) throw new EffectDeniedError('conversation type/MID mismatch');
    if (!/^(?:0|[1-9][0-9]*)$/.test(messageId) || BigInt(messageId) > 9223372036854775807n) {
      throw new EffectDeniedError('message ID is not a LINE int64');
    }
    await this.#gate.invokeRpc({ phase: 'MANUAL_SEND', lease }, () => this.#base.talk.unsendMessage({ messageId }));
  }
  async checkFriendRelation(targetMid: string, lease: ControlLease, signal: RelationCancellation = { aborted: false }): Promise<FriendRelation> {
    return (await this.checkFriendRelationDiagnostic(targetMid, lease, signal)).status;
  }
  async checkFriendRelationDiagnostic(targetMid: string, lease: ControlLease,
    signal: RelationCancellation = { aborted: false }): Promise<FriendRelationDiagnostic> {
    if (this.#options.mode !== 'ACTIVE_CONTROL' || this.#revoked) return { status: 'unknown', error: 'RELATION_BINDING_REVOKED' };
    const unknown = (error: string): FriendRelationDiagnostic => ({ status: 'unknown', error });
    try {
      const seenTokens = new Set<string>();
      let token: string | undefined;
      let entries = 0;
      for (let page = 0; page < 100; page += 1) {
        if (signal.aborted || this.#revoked) return unknown(this.#revoked ? 'RELATION_BINDING_REVOKED' : 'RELATION_CANCELLED');
        const response = await this.#gate.invokeRpc({ phase: 'CONTROL_READ', lease }, () =>
          this.#base.relation.getUserFriendIds({ request: { blockStatus: 'NOT_BLOCK', ...(token ? { userPageToken: token } : {}) } })) as unknown;
        if (signal.aborted || this.#revoked) return unknown(this.#revoked ? 'RELATION_BINDING_REVOKED' : 'RELATION_CANCELLED');
        if (!response || typeof response !== 'object' || Array.isArray(response)) return unknown('RELATION_LIST_SHAPE_INVALID');
        const pageResult = response as Record<string, unknown>;
        const midsValue = pageResult.userFriendMids;
        const tokenValue = pageResult.nextUserPageToken;
        if ((midsValue !== undefined && !Array.isArray(midsValue)) ||
            (tokenValue !== undefined && typeof tokenValue !== 'string')) return unknown('RELATION_LIST_SHAPE_INVALID');
        const mids = midsValue === undefined ? [] : midsValue as unknown[];
        entries += mids.length;
        if (entries > 100_000) return unknown('RELATION_LIST_LIMIT');
        if (mids.some((mid) => typeof mid !== 'string')) return unknown('RELATION_LIST_SHAPE_INVALID');
        if (mids.includes(targetMid)) return { status: 'friend', error: null };
        const next = tokenValue === undefined ? '' : tokenValue as string;
        if (next === '') break;
        if (seenTokens.has(next)) return unknown('RELATION_LIST_LIMIT');
        seenTokens.add(next);
        if (page === 99) return unknown('RELATION_LIST_LIMIT');
        token = next;
      }
      return { status: 'not_friend', error: null };
    } catch {
      if (this.#revoked) return unknown('RELATION_BINDING_REVOKED');
      if (signal.aborted) return unknown('RELATION_CANCELLED');
      return unknown('RELATION_LIST_RPC_FAILED');
    }
  }
  async addFriendByMid(targetMid: string, lease: ControlLease, onPhysicalStart: () => void,
    signal: RelationCancellation = { aborted: false }, sourceChatMid?: string): Promise<FriendAddResult> {
    if (this.#options.mode !== 'ACTIVE_CONTROL' || this.#revoked || this.#activeRelationAdd) {
      return { status: 'failed', error: 'SIDE_EFFECT_DENIED' };
    }
    const state: RelationAddContext = { consumed: false, signal, onPhysicalStart };
    this.#activeRelationAdd = state;
    try {
      await this.#gate.invokeRpc({ phase: 'CONTROL_SEND', lease },
        () => {
          if (signal.aborted || this.#revoked || this.#options.mode !== 'ACTIVE_CONTROL') {
            throw new EffectDeniedError('Relation add cancelled before LINEJS call');
          }
          return this.#base.relation.addFriendByMid(sourceChatMid === undefined
            ? { mid: targetMid, reference: '', trackingMetaType: 10 }
            : { mid: targetMid, reference: '', trackingMetaType: 5, trackingMetaHint: sourceChatMid });
        });
      return { status: 'added', error: null };
    } catch (error) {
      if (!state.consumed) return { status: 'failed', error: error instanceof EffectDeniedError ? 'SIDE_EFFECT_DENIED' : 'NOT_STARTED' };
      const rejectionError = friendAddRejectionError(error);
      return rejectionError ? { status: 'failed', error: rejectionError }
        : { status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' };
    } finally { this.#activeRelationAdd = undefined; }
  }
  revoke(): void { this.#revoked = true; this.#adoptedObsToken = null; this.#cancelTokenRefresh(true); }
  #clearChatResourceTokens(): void {
    const timeline = this.#base.timeline as unknown as { timelineToken?: string; timelineHeaders: Record<string, string | undefined> };
    delete timeline.timelineToken;
    timeline.timelineHeaders = {};
    this.#base.moa.clearAlbumChannelToken();
  }
  #readContext(): { phase: 'CONTROL_READ'; lease: ControlLease } | { phase: 'MONITOR_READ' } {
    return this.#options.mode === 'ACTIVE_CONTROL' && !this.#revoked
      ? { phase: 'CONTROL_READ', lease: this.#lease() } : { phase: 'MONITOR_READ' };
  }
  #lease(): ControlLease {
    return { accountId: this.#options.accountId, workerInstanceId: this.#options.workerInstanceId,
      controlEpoch: this.#options.controlEpoch };
  }
}

export async function createLinejsAdapter(options: LinejsAdapterOptions): Promise<LinejsAdapter> {
  return LinejsAdapter.create(options);
}
