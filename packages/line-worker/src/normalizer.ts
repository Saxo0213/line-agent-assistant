import { Buffer } from 'node:buffer';
import { TalkMessage } from '@evex/linejs';
import { lineContentKind, type ContactDescriptor, type InboundEnvelope } from '@line-agent/contracts';

type RecordValue = Record<string, unknown>;
const MAX_NATIVE_MESSAGE_CHUNKS = 64;
// Encrypted message chunks hold a small key envelope, not the downloaded media.
const MAX_NATIVE_MESSAGE_CHUNK_BYTES = 1024 * 1024;
const INVALID_NATIVE_CHUNKS = [{ encoding: 'invalid-native-chunks', reason: 'limit' }];
export type NormalizeContext = Readonly<{
  accountId: string;
  ownMid: string;
  source: 'live' | 'history';
  cursor: string | null;
}>;
export type DecryptionFailure = Readonly<{
  code: 'SIDE_EFFECT_DENIED' | 'MISSING_E2EE_KEY' | 'AUTH_FAILED' | 'MALFORMED';
  retryable: boolean;
}>;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}
function stringId(value: unknown, field: string): string {
  if (typeof value === 'bigint' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`${field} is unsafe`);
    return String(value);
  }
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is missing`);
  return value;
}
function databaseText(value: string): string {
  // PostgreSQL text/jsonb rejects U+0000 even when JSON.stringify escapes it.
  // Preserve the position without allowing one opaque LINE metadata value to
  // roll back the complete incoming-message batch.
  return value.replaceAll('\0', '\uFFFD');
}
function serializeNativeChunks(chunks: unknown[], ancestors: WeakSet<object>): unknown[] {
  if (chunks.length > MAX_NATIVE_MESSAGE_CHUNKS) return INVALID_NATIVE_CHUNKS;
  let totalBytes = 0;
  for (const chunk of chunks) {
    if (typeof chunk === 'string') totalBytes += Buffer.byteLength(chunk, 'utf8');
    else if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) totalBytes += chunk.byteLength;
    else return INVALID_NATIVE_CHUNKS;
    if (totalBytes > MAX_NATIVE_MESSAGE_CHUNK_BYTES) return INVALID_NATIVE_CHUNKS;
  }
  return chunks.map((chunk) => typeof chunk === 'string'
    ? { encoding: 'base64', data: Buffer.from(chunk, 'utf8').toString('base64') }
    : jsonValue(chunk, ancestors));
}
function jsonValue(value: unknown, ancestors: WeakSet<object>, nativeMessage = false, nativeOperation = false): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return databaseText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value instanceof Uint8Array) return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
  if (value instanceof ArrayBuffer) return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object' || value === undefined) return null;
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, ancestors));
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => {
        if (nativeMessage && key === 'chunks' && Array.isArray(item)) {
          return [databaseText(key), serializeNativeChunks(item, ancestors)];
        }
        return [databaseText(key), jsonValue(item, ancestors, nativeOperation && key === 'message', false)];
      }));
  } finally {
    ancestors.delete(value);
  }
}

export function safeRaw(value: unknown): InboundEnvelope['raw'] {
  return jsonValue(value, new WeakSet()) as InboundEnvelope['raw'];
}

function safeRawOperation(value: unknown): InboundEnvelope['raw'] {
  return jsonValue(value, new WeakSet(), false, true) as InboundEnvelope['raw'];
}

function mentions(text: string | null, metadata: RecordValue): Pick<InboundEnvelope, 'mentionIds' | 'mentionRanges'> {
  if (text === null || typeof metadata.MENTION !== 'string') return { mentionIds: [], mentionRanges: [] };
  try {
    const parsed = record(JSON.parse(metadata.MENTION));
    if (!Array.isArray(parsed.MENTIONEES)) return { mentionIds: [], mentionRanges: [] };
    const mentionRanges: InboundEnvelope['mentionRanges'] = [];
    for (const item of parsed.MENTIONEES) {
      const entry = record(item);
      const start = Number(entry.S);
      const end = Number(entry.E);
      const userId = entry.A === '1' || entry.A === true ? '@all' : entry.M;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
        end > text.length || typeof userId !== 'string' || userId.length === 0) continue;
      mentionRanges.push({ start, end, userId });
    }
    return { mentionIds: [...new Set(mentionRanges.map((range) => range.userId))], mentionRanges };
  } catch {
    return { mentionIds: [], mentionRanges: [] };
  }
}

function contentKind(value: unknown): InboundEnvelope['kind'] {
  return lineContentKind(value);
}

const LINE_USER_MID = /^u[0-9a-f]{32}$/i;

function sharedContact(message: RecordValue): ContactDescriptor | null {
  try {
    const accessor = message.getSharedContact;
    const result = typeof accessor === 'function'
      ? (accessor as () => unknown).call(message)
      : new TalkMessage({ raw: message as never, client: {} as never }).getSharedContact();
    const contact = record(result);
    if (typeof contact.mid !== 'string' || !LINE_USER_MID.test(contact.mid)) return null;
    const displayName = typeof contact.displayName === 'string' ? databaseText(contact.displayName).slice(0, 128) : null;
    return { mid: contact.mid, displayName };
  } catch {
    return null;
  }
}

export function normalizeOperation(
  operationValue: unknown,
  context: NormalizeContext,
  decryptionFailure?: DecryptionFailure,
): InboundEnvelope {
  const operation = record(operationValue);
  const message = record(operation.message);
  const metadata = record(message.contentMetadata);
  const messageId = stringId(message.id ?? operation.revision, 'messageId');
  const senderId = stringId(message.from ?? operation.param2 ?? context.ownMid, 'senderId');
  const destination = stringId(message.to ?? operation.param1 ?? senderId, 'destination');
  const toType = message.toType;
  const chatType = toType === 2 || destination.startsWith('c') ? 'group'
    : toType === 1 || destination.startsWith('r') ? 'room' : 'direct';
  const chatId = chatType === 'direct' && destination === context.ownMid ? senderId : destination;
  const timestamp = message.createdTime ?? message.deliveredTime ?? Date.now();
  const occurredAt = new Date(Number(timestamp)).toISOString();
  const isNativeContact = !decryptionFailure && (message.contentType === 'CONTACT' || message.contentType === 13);
  const contact = isNativeContact ? sharedContact(message) : null;
  const rejectedContact = isNativeContact && contact === null;
  const location = !decryptionFailure ? record(message.location) : {};
  const hasLocation = Object.keys(location).length > 0;
  const kind = decryptionFailure || rejectedContact ? 'event'
    : isNativeContact ? 'contact' : hasLocation ? 'location' : contentKind(message.contentType);
  const text = decryptionFailure || isNativeContact ? null : typeof message.text === 'string' ? databaseText(message.text) : null;
  const attachmentKinds = new Set(['image', 'video', 'audio', 'file']);
  const size = Number(metadata.FILE_SIZE);
  const attachments = !decryptionFailure && attachmentKinds.has(kind)
    ? [{ id: messageId, kind: kind as 'image' | 'video' | 'audio' | 'file',
      name: typeof metadata.FILE_NAME === 'string' ? databaseText(metadata.FILE_NAME) : null,
      mimeType: typeof metadata.MIME_TYPE === 'string' ? databaseText(metadata.MIME_TYPE) : null,
      sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : null }]
    : [];
  return {
    eventId: stringId(operation.revision ?? messageId, 'eventId'),
    accountId: context.accountId, chatId, chatType, senderId, messageId, kind, text,
    ...(decryptionFailure ? { mentionIds: [], mentionRanges: [] } : mentions(text, metadata)),
    replyToMessageId: !decryptionFailure && message.relatedMessageId != null &&
      (message.messageRelationType === 3 || message.messageRelationType === 'REPLY')
      ? stringId(message.relatedMessageId, 'relatedMessageId') : null,
    ingestion: { source: context.source, cursor: context.cursor }, occurredAt, attachments,
    ...(contact ? { contact } : {}),
    raw: isNativeContact ? rejectedContact ? { contentState: 'contact_rejected' } : {}
      : decryptionFailure
      ? { ...record(safeRawOperation(operation)), contentState: 'decrypt_failed',
        error: { code: decryptionFailure.code } }
      : safeRawOperation(operation),
  };
}
