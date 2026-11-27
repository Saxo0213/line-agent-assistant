import { ArchiveInboundEnvelopeSchema, type ArchiveInboundEnvelope } from '@line-agent/contracts';
import { messageContent, safeRawMessage } from './normalizer.js';

type RecordValue = Record<string, unknown>;

export type SquareEventType = 'RECEIVE_MESSAGE' | 'SEND_MESSAGE' | 'NOTIFICATION_MESSAGE';
/** Counts only. They never hold message text, ids or names. */
export type SquareNormalizeCounts = { events: number; ignored: number; thread: number; duplicate: number; invalid: number };
export type SquareNormalizeResult = Readonly<{ envelopes: ArchiveInboundEnvelope[]; counts: SquareNormalizeCounts }>;

// LINE SquareEventType numbers. LINEJS keeps the number in a decoded event; a name is accepted too.
const EVENT_TYPES: ReadonlyMap<unknown, SquareEventType> = new Map<unknown, SquareEventType>([
  [0, 'RECEIVE_MESSAGE'], ['RECEIVE_MESSAGE', 'RECEIVE_MESSAGE'],
  [1, 'SEND_MESSAGE'], ['SEND_MESSAGE', 'SEND_MESSAGE'],
  [29, 'NOTIFICATION_MESSAGE'], ['NOTIFICATION_MESSAGE', 'NOTIFICATION_MESSAGE'],
]);
const PAYLOAD_KEY: Readonly<Record<SquareEventType, string>> = {
  RECEIVE_MESSAGE: 'receiveMessage', SEND_MESSAGE: 'sendMessage', NOTIFICATION_MESSAGE: 'notificationMessage',
};
const SENDER_NAME_MAX = 256;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function idText(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  return nonEmptyString(value);
}
/** True for a thread message: a thread MID on the event, or thread info on the Square message. */
function isThreadMessage(body: RecordValue, squareMessage: RecordValue): boolean {
  if (nonEmptyString(body.threadMid) !== undefined) return true;
  const info = record(squareMessage.threadInfo);
  return nonEmptyString(info.chatThreadMid) !== undefined || info.threadRoot === true;
}

/**
 * Maps LINE Square events to archive envelopes. Only RECEIVE_MESSAGE, SEND_MESSAGE and NOTIFICATION_MESSAGE
 * give an envelope. A thread message is skipped. A message id seen twice in one call gives one envelope.
 * An envelope that fails its schema is dropped. The content fields come from the same code as a Talk message.
 */
export function normalizeSquareEvents(events: readonly unknown[], context: Readonly<{ accountId: string; source?: 'live' | 'history' }>): SquareNormalizeResult {
  const source = context.source ?? 'live';
  const counts: SquareNormalizeCounts = { events: events.length, ignored: 0, thread: 0, duplicate: 0, invalid: 0 };
  const byMessageId = new Map<string, { envelope: ArchiveInboundEnvelope; own: boolean }>();
  for (const eventValue of events) {
    const event = record(eventValue);
    const eventType = EVENT_TYPES.get(event.type);
    if (eventType === undefined) { counts.ignored += 1; continue; }
    try {
      const body = record(record(event.payload)[PAYLOAD_KEY[eventType]]);
      const squareMessage = record(body.squareMessage);
      if (isThreadMessage(body, squareMessage)) { counts.thread += 1; continue; }
      const message = record(squareMessage.message);
      const messageId = idText(message.id);
      const chatId = nonEmptyString(body.squareChatMid) ?? nonEmptyString(message.to);
      const senderId = nonEmptyString(message.from);
      const timestamp = Number(typeof message.createdTime === 'bigint' ? message.createdTime.toString() : message.createdTime ?? message.deliveredTime);
      if (messageId === undefined || chatId === undefined || senderId === undefined || !Number.isFinite(timestamp)) {
        counts.invalid += 1; continue;
      }
      const content = messageContent(message, messageId);
      const own = eventType === 'SEND_MESSAGE';
      const senderName = nonEmptyString(body.senderDisplayName)?.replaceAll('\0', '�').slice(0, SENDER_NAME_MAX);
      const rawMessage = content.isNativeContact
        ? content.rejectedContact ? { contentState: 'contact_rejected' } : {}
        : safeRawMessage(message);
      const candidate = {
        eventId: messageId, accountId: context.accountId, chatId, chatType: 'community', senderId, messageId,
        kind: content.kind, text: content.text, ...content.mentions, replyToMessageId: content.replyToMessageId,
        ingestion: { source, cursor: null }, occurredAt: new Date(timestamp).toISOString(),
        attachments: content.attachments, ...(content.contact ? { contact: content.contact } : {}),
        ...(senderName ? { senderName } : {}),
        raw: { message: rawMessage, square: { eventType, own } },
      };
      const parsed = ArchiveInboundEnvelopeSchema.safeParse(candidate);
      if (!parsed.success) { counts.invalid += 1; continue; }
      const existing = byMessageId.get(messageId);
      if (existing) {
        counts.duplicate += 1;
        // The own copy (SEND_MESSAGE) wins, so the stored row keeps the right direction.
        if (own && !existing.own) byMessageId.set(messageId, { envelope: parsed.data, own });
        continue;
      }
      byMessageId.set(messageId, { envelope: parsed.data, own });
    } catch {
      counts.invalid += 1;
    }
  }
  return { envelopes: [...byMessageId.values()].map((entry) => entry.envelope), counts };
}
