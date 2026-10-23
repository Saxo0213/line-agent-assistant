import { Buffer } from 'node:buffer';
import type { JsonValue, NativeAttachmentDownloadInput } from '@line-agent/contracts';
import { SafeAttachmentError } from './attachment-error.js';

export type AttachmentDownloadIdentity = Readonly<{
  accountId: string;
  chatType: 'direct' | 'group' | 'room';
  chatId: string;
  ownMid: string;
  messageId: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  externalAttachmentId: string;
}>;
export type ValidatedAttachmentMessage = Readonly<{
  message: Record<string, unknown>;
  metadata: Record<string, unknown>;
  encrypted: boolean;
  sid: string;
  oid: string;
  tid: string | null;
  obsPop: string | null;
  advertisedSize: number | null;
}>;

export function parseEncryptedAccessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new SafeAttachmentError('LINE_OBS_TOKEN_INVALID');
  const separator = value.indexOf('\u001e');
  if (separator < 0 || separator !== value.lastIndexOf('\u001e')) throw new SafeAttachmentError('LINE_OBS_TOKEN_INVALID');
  const token = value.slice(separator + 1);
  // LINE's Go client uses expiry only as an optional cache hint. It returns
  // the token even when expiry is not parseable and imposes no one-day cap.
  // Keep the value bounded and safe for an HTTP header before using it.
  if (token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new SafeAttachmentError('LINE_OBS_TOKEN_INVALID');
  }
  return token;
}

const SID_BY_KIND = { image: 'emi', video: 'emv', audio: 'ema', file: 'emf' } as const;
const TYPE_BY_KIND = { image: 1, video: 2, audio: 3, file: 14 } as const;
const TYPE_NAME_BY_KIND = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', file: 'FILE' } as const;
const failure = (): never => { throw new SafeAttachmentError('ATTACHMENT_METADATA_INVALID'); };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function restoreAttachmentBinaryJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreAttachmentBinaryJson);
  if (!isRecord(value)) return value;
  if (value.encoding === 'base64' && typeof value.data === 'string' && Object.keys(value).length === 2) {
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.toString('base64') !== value.data) return failure();
    return new Uint8Array(bytes);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreAttachmentBinaryJson(entry)]));
}

export function validateAttachmentMessage(value: JsonValue, identity: AttachmentDownloadIdentity,
  maxBytes: number): ValidatedAttachmentMessage {
  if (isRecord(value)) {
    const rawChunks = value.chunks;
    if (rawChunks !== undefined) {
      if (!Array.isArray(rawChunks) || rawChunks.length > 64) return failure();
      let chunkBytes = 0;
      for (const chunk of rawChunks) {
        if (typeof chunk === 'string') {
          if (chunk.length === 0 || chunk.length > maxBytes + 32) return failure();
          chunkBytes += Buffer.byteLength(chunk, 'utf8');
        } else {
          if (!isRecord(chunk) || chunk.encoding !== 'base64' || typeof chunk.data !== 'string'
            || Object.keys(chunk).length !== 2 || chunk.data.length > Math.ceil((maxBytes + 32) * 4 / 3) + 4) return failure();
          const encoded = chunk.data;
          const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
          chunkBytes += Math.floor(encoded.length * 3 / 4) - padding;
        }
        if (chunkBytes > maxBytes + 32) return failure();
      }
    }
  }
  const raw = restoreAttachmentBinaryJson(value);
  if (!isRecord(raw) || raw.id !== identity.messageId) return failure();
  const message = raw;
  const from = message.from;
  const to = message.to;
  if (typeof from !== 'string' || typeof to !== 'string' || !/^u[0-9A-Fa-f]{32}$/.test(identity.ownMid)) return failure();
  if (identity.chatType === 'direct') {
    const correct = (from === identity.ownMid && to === identity.chatId)
      || (to === identity.ownMid && from === identity.chatId);
    if (!correct || (message.toType !== 0 && message.toType !== 'USER') || !/^u[0-9A-Fa-f]{32}$/.test(identity.chatId)) return failure();
  } else if (identity.chatType === 'group') {
    if (to !== identity.chatId || (message.toType !== 2 && message.toType !== 'GROUP') || !/^c[0-9A-Fa-f]{32}$/.test(identity.chatId)
      || !/^u[0-9A-Fa-f]{32}$/.test(from)) return failure();
  } else if (identity.chatType === 'room') {
    if (to !== identity.chatId || (message.toType !== 1 && message.toType !== 'ROOM') || !/^r[0-9A-Fa-f]{32}$/.test(identity.chatId)
      || !/^u[0-9A-Fa-f]{32}$/.test(from)) return failure();
  }
  const expectedType = TYPE_BY_KIND[identity.kind];
  if (message.contentType !== expectedType && message.contentType !== TYPE_NAME_BY_KIND[identity.kind]) return failure();
  const metadata = isRecord(message.contentMetadata) ? message.contentMetadata : failure();
  if (Object.hasOwn(metadata, 'DOWNLOAD_URL')) return failure();
  if (Object.entries(metadata).some(([key, entry]) => key.length > 64 || typeof entry !== 'string' || entry.length > 8192)) return failure();
  const chunks = message.chunks;
  if (chunks !== undefined && !Array.isArray(chunks)) return failure();
  if (Array.isArray(chunks) && (chunks.length > 64 || chunks.some((chunk) =>
    !(chunk instanceof Uint8Array) && (typeof chunk !== 'string' || chunk.length === 0)))) return failure();
  const oidValue = metadata.OID;
  const sidValue = metadata.SID;
  const encrypted = typeof oidValue === 'string' && oidValue.length > 0;
  const sid = SID_BY_KIND[identity.kind];
  let oid: string;
  let tid: string | null = null;
  if (encrypted) {
    if (!/^(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(oidValue)
      || (identity.externalAttachmentId !== oidValue && identity.externalAttachmentId !== message.id)
      || (sidValue !== undefined && sidValue !== sid)
      || !Array.isArray(chunks) || chunks.length === 0) return failure();
    oid = oidValue;
  } else {
    if (identity.externalAttachmentId !== identity.messageId || (sidValue !== undefined && sidValue !== 'm')
      || (Array.isArray(chunks) && chunks.length > 0) || metadata.e2eeVersion !== undefined || metadata.ENC_KM !== undefined
      || (typeof sidValue === 'string' && sidValue.startsWith('em'))) return failure();
    oid = identity.messageId;
    if (typeof metadata.MEDIA_CONTENT_INFO === 'string') {
      if (metadata.MEDIA_CONTENT_INFO.length > 4096) return failure();
      let info: unknown;
      try {
        info = JSON.parse(metadata.MEDIA_CONTENT_INFO);
      } catch { /* malformed optional metadata follows the Go CLI default */ }
      if (info !== undefined) {
        if (!isRecord(info) || (info.category !== undefined && typeof info.category !== 'string')) return failure();
        if (info.category === 'original') tid = 'original';
      }
    }
  }
  if (typeof sidValue === 'string' && sidValue !== sid && sidValue !== 'm') return failure();
  const popValue = metadata.OBS_POP;
  if (popValue !== undefined && (typeof popValue !== 'string' || popValue.length === 0 || popValue.length > 256
    || /[\u0000-\u001f\u007f/\\]/.test(popValue))) return failure();
  let advertisedSize: number | null = null;
  const sizeValue = metadata.FILE_SIZE;
  if (sizeValue !== undefined) {
    if (typeof sizeValue !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(sizeValue)) return failure();
    advertisedSize = Number(sizeValue);
    if (!Number.isSafeInteger(advertisedSize) || advertisedSize > maxBytes + (encrypted ? 32 : 0)) return failure();
  }
  return { message, metadata, encrypted, sid: encrypted ? sid : 'm', oid, tid,
    obsPop: typeof popValue === 'string' ? popValue : null, advertisedSize };
}

export function validateNativeAttachment(input: NativeAttachmentDownloadInput, identity: AttachmentDownloadIdentity,
  maxBytes: number): ValidatedAttachmentMessage & Readonly<{ keyMaterial: Buffer | null; fileName: string | null }> {
  if (!input || input.messageId !== identity.messageId || input.chatId !== identity.chatId
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !/^u[0-9A-Fa-f]{32}$/.test(identity.ownMid)) return failure();
  const expectedType = TYPE_BY_KIND[identity.kind];
  if (input.contentType !== expectedType) return failure();
  const chatPrefix = identity.chatType === 'direct' ? 'u' : identity.chatType === 'group' ? 'c' : 'r';
  if (!new RegExp(`^${chatPrefix}[0-9A-Fa-f]{32}$`).test(identity.chatId)) return failure();
  if (identity.chatType === 'direct') {
    if ((input.from !== null && input.from !== identity.ownMid && input.from !== identity.chatId)
      || (input.to !== null && input.to !== identity.ownMid && input.to !== identity.chatId)
      || (input.from !== null && input.to !== null && !((input.from === identity.ownMid && input.to === identity.chatId)
        || (input.to === identity.ownMid && input.from === identity.chatId)))
      || (input.toType !== null && input.toType !== 0)) return failure();
  } else {
    if ((input.to !== null && input.to !== identity.chatId)
      || (input.from !== null && !/^u[0-9A-Fa-f]{32}$/.test(input.from))
      || (input.toType !== null && input.toType !== (identity.chatType === 'group' ? 2 : 1))) return failure();
  }
  const source = input.contentMetadata;
  if (source.DOWNLOAD_URL !== null) return failure();
  const oidValue = source.OID;
  const sidValue = source.SID;
  const encrypted = oidValue !== null && oidValue.length > 0;
  const expectedSid = SID_BY_KIND[identity.kind];
  let oid = identity.messageId;
  let sid: string = 'm';
  if (encrypted) {
    if (!/^(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(oidValue)
      || (identity.externalAttachmentId !== oidValue && identity.externalAttachmentId !== identity.messageId)
      || sidValue !== expectedSid || input.keyMaterial === null) return failure();
    oid = oidValue;
    sid = expectedSid;
  } else if ((identity.externalAttachmentId !== identity.messageId) || (sidValue !== null && sidValue !== 'm')
    || input.keyMaterial !== null) return failure();
  const mediaInfo = source.MEDIA_CONTENT_INFO;
  let tid: string | null = null;
  if (mediaInfo !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(mediaInfo); } catch { parsed = undefined; }
    if (parsed !== undefined) {
      if (!isRecord(parsed) || (parsed.category !== undefined && typeof parsed.category !== 'string')) return failure();
      if (parsed.category === 'original') tid = 'original';
    }
  }
  const obsPop = source.OBS_POP;
  if (obsPop !== null && (obsPop.length === 0 || /[\u0000-\u001f\u007f/\\]/.test(obsPop))) return failure();
  let advertisedSize: number | null = null;
  if (source.FILE_SIZE !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(source.FILE_SIZE)) return failure();
    advertisedSize = Number(source.FILE_SIZE);
    if (!Number.isSafeInteger(advertisedSize) || advertisedSize > maxBytes + (encrypted ? 32 : 0)) return failure();
  }
  let keyMaterial: Buffer | null = null;
  if (input.keyMaterial !== null) {
    keyMaterial = Buffer.from(input.keyMaterial, 'base64');
    if (keyMaterial.length !== 32 || keyMaterial.toString('base64') !== input.keyMaterial) return failure();
  }
  const metadata = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== null));
  return { message: { id: input.messageId }, metadata, encrypted, sid, oid, tid, obsPop, advertisedSize,
    keyMaterial, fileName: input.fileName };
}
