import { redactRoomTokens, type InboundEnvelope } from '@line-agent/contracts';
import { findOwnMentionRange } from './trigger-router.js';

export type RoomActivationCommand =
  | Readonly<{ type: 'request'; accountId: string; chatType: 'group' | 'room'; chatId: string; senderId: string; messageId: string }>
  | Readonly<{ type: 'confirmation-candidate'; accountId: string; chatType: 'group' | 'room'; chatId: string;
      senderId: string; messageId: string; token: string }>;

export type RoomControlClassification =
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'command'; command: RoomActivationCommand }>
  | Readonly<{ type: 'reserved-token-candidate' }>;

const APPROVED_TOKEN = /^RA-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TOKEN_CANDIDATE = /RA-[A-Za-z0-9_-]+/g;

// Room tokens are replaced in place with the shared marker (same rule as the native writer).
function redactString(value: string): string {
  return redactRoomTokens(value).text;
}

function redactJson(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactString(key), redactJson(item)]));
  }
  return value;
}

export function sanitizeRoomControlEnvelope(envelope: InboundEnvelope): InboundEnvelope {
  const redacted = envelope.text === null ? null : redactRoomTokens(envelope.text, envelope.mentionRanges);
  return {
    ...envelope,
    text: redacted?.text ?? null,
    mentionRanges: redacted?.mentionRanges ?? [],
    attachments: envelope.attachments.map((attachment) => ({
      ...attachment,
      name: attachment.name === null ? null : redactString(attachment.name),
      mimeType: attachment.mimeType === null ? null : redactString(attachment.mimeType),
    })),
    raw: redactJson(envelope.raw) as InboundEnvelope['raw'],
  };
}

function commandText(envelope: InboundEnvelope, ownMid: string): string | null {
  if (envelope.chatType === 'direct' || envelope.kind !== 'text' || envelope.text === null
    || envelope.senderId === ownMid || envelope.ingestion.source !== 'live') return null;
  const mention = findOwnMentionRange(envelope, ownMid, (range, text) => text.slice(0, range.start).trim().length === 0);
  return mention
    ? (envelope.text.slice(0, mention.start) + envelope.text.slice(mention.end)).normalize('NFC').trim() : null;
}

export function ownMentionBody(envelope: InboundEnvelope, ownMid: string | null): string | null {
  if (ownMid === null || envelope.accountId.length === 0 || envelope.chatType === 'direct' || envelope.kind !== 'text'
    || envelope.text === null || envelope.senderId === ownMid || envelope.ingestion.source !== 'live') return null;
  const mention = findOwnMentionRange(envelope, ownMid, (range, text) => text.slice(0, range.start).trim().length === 0);
  return mention
    ? (envelope.text.slice(0, mention.start) + envelope.text.slice(mention.end)).normalize('NFC').trim().replace(/\s+/gu, ' ') : null;
}

export function classifyRoomControl(
  envelope: InboundEnvelope,
  ownMid: string | null,
  expectedAccountId: string = envelope.accountId,
): RoomControlClassification {
  const candidates = envelope.text?.match(TOKEN_CANDIDATE) ?? [];
  if (candidates.length > 0) {
    const text = ownMid !== null && envelope.accountId === expectedAccountId
      && (envelope.chatType === 'group' || envelope.chatType === 'room')
      ? commandText(envelope, ownMid) : null;
    const token = text && APPROVED_TOKEN.test(text) && candidates.length === 1 && candidates[0] === text ? text : null;
    if (token && ownMid !== null) {
      return { type: 'command', command: { type: 'confirmation-candidate', accountId: envelope.accountId,
        chatType: envelope.chatType as 'group' | 'room', chatId: envelope.chatId, senderId: envelope.senderId,
        messageId: envelope.messageId, token } };
    }
    return { type: 'reserved-token-candidate' };
  }

  if (ownMid === null || envelope.accountId !== expectedAccountId
    || (envelope.chatType !== 'group' && envelope.chatType !== 'room')) return { type: 'none' };
  const text = commandText(envelope, ownMid);
  if (text === '監控' || /^[mM][oO][nN][iI][tT][oO][rR]$/.test(text ?? '')) {
    return { type: 'command', command: { type: 'request', accountId: envelope.accountId,
      chatType: envelope.chatType, chatId: envelope.chatId, senderId: envelope.senderId, messageId: envelope.messageId } };
  }
  return { type: 'none' };
}
