import { redactRoomTokens, type InboundEnvelope } from '@line-agent/contracts';
import { findOwnMentionRange } from './trigger-router.js';

export type RoomControlClassification =
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'reserved-token-candidate' }>;

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

export function ownMentionBody(envelope: InboundEnvelope, ownMid: string | null): string | null {
  if (ownMid === null || envelope.accountId.length === 0 || envelope.chatType === 'direct' || envelope.kind !== 'text'
    || envelope.text === null || envelope.senderId === ownMid || envelope.ingestion.source !== 'live') return null;
  const mention = findOwnMentionRange(envelope, ownMid, (range, text) => text.slice(0, range.start).trim().length === 0);
  return mention
    ? (envelope.text.slice(0, mention.start) + envelope.text.slice(mention.end)).normalize('NFC').trim().replace(/\s+/gu, ' ') : null;
}

/** A text that holds an `RA-` token is reserved: it is stored redacted and never reaches the Agent. */
export function classifyRoomControl(envelope: InboundEnvelope): RoomControlClassification {
  return (envelope.text?.match(TOKEN_CANDIDATE) ?? []).length > 0 ? { type: 'reserved-token-candidate' } : { type: 'none' };
}
