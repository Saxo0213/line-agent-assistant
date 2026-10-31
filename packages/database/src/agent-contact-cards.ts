import type { InboundEnvelope } from '@line-agent/contracts';
import { bridgeNativeEnvelope } from './content-bridge/index.js';

/** Contact cards shown to the Agent with the next text of the same sender (docs/architecture/agent-line-send.md). */
export const AGENT_CONTACT_CARD_LIMIT = 3;
export const AGENT_CONTACT_CARD_WINDOW_MS = 30 * 60_000;
export const AGENT_CONTACT_CARD_PREFIX = '[聯絡人卡片]';

export interface ContactCard { messageId: string; occurredAt: Date; mid: string | null; displayName: string | null }
interface Queryable { query<R extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>; }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length === 0 ? null : flat.slice(0, max);
};

/**
 * The shared contact of a stored contact message. Reads the projected `content`, then the live raw form
 * (`{ loginContact: { mid, displayName } }`), then the native row form (`raw.native`, a format 2 `_message` envelope).
 */
export function parseStoredContact(content: unknown, raw: unknown): { mid: string | null; displayName: string | null } | null {
  if (isRecord(content) && content.type === 'contact') {
    const mid = text(content.mid, 512);
    const displayName = text(content.displayName, 128);
    if (mid || displayName) return { mid, displayName };
  }
  if (isRecord(raw) && isRecord(raw.loginContact)) {
    const mid = text(raw.loginContact.mid, 512);
    const displayName = text(raw.loginContact.displayName, 128);
    if (mid || displayName) return { mid, displayName };
  }
  const nativeEnvelope = isRecord(raw) ? (raw.format === 2 ? raw : isRecord(raw.native) ? raw.native : null) : null;
  if (nativeEnvelope) {
    try {
      const bridged = bridgeNativeEnvelope(nativeEnvelope as never);
      if (bridged?.content?.type === 'contact' && (bridged.content.mid || bridged.content.displayName)) {
        return { mid: bridged.content.mid, displayName: bridged.content.displayName };
      }
    } catch { /* an unreadable envelope is not a card */ }
  }
  return null;
}

/** One line per card, oldest first: `[聯絡人卡片] 徐佳誠（mid: u…）`. */
export function formatContactCardBlock(cards: readonly Pick<ContactCard, 'mid' | 'displayName'>[]): string {
  return cards.map((card) => `${AGENT_CONTACT_CARD_PREFIX} ${card.displayName ?? '（未命名）'}${card.mid ? `（mid: ${card.mid}）` : ''}`).join('\n');
}

/**
 * Contact cards the same sender shared in this chat after the previous Agent job of the chat (and within 30 minutes before this
 * message): the last three, oldest first. `batchEnvelopes` adds cards of the same batch that may not be stored yet.
 */
export async function recentContactCards(db: Queryable, envelope: InboundEnvelope, batchEnvelopes: readonly InboundEnvelope[] = []): Promise<ContactCard[]> {
  const at = new Date(envelope.occurredAt);
  if (Number.isNaN(at.getTime())) return [];
  const previous = await db.query<{ occurred_at: Date }>(
    `SELECT m.occurred_at FROM agent_jobs j JOIN messages m ON m.account_id = j.account_id AND m.message_id = j.source_message_id
     WHERE j.account_id = $1 AND j.chat_type = $2 AND j.chat_id = $3 AND j.source_type = 'line' AND j.retry_of_job_id IS NULL AND j.source_message_id <> $4
     ORDER BY m.occurred_at DESC LIMIT 1`, [envelope.accountId, envelope.chatType, envelope.chatId, envelope.messageId]);
  const after = Math.max(at.getTime() - AGENT_CONTACT_CARD_WINDOW_MS, previous.rows[0] ? new Date(previous.rows[0].occurred_at).getTime() : Number.NEGATIVE_INFINITY);
  const stored = await db.query<{ message_id: string; occurred_at: Date; content: unknown; raw: unknown }>(
    `SELECT message_id, occurred_at, content, raw FROM messages
     WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND sender_id = $4 AND kind = 'contact' AND message_id <> $5
       AND occurred_at <= $6 AND occurred_at > $7
     ORDER BY occurred_at DESC, message_id DESC LIMIT $8`,
    [envelope.accountId, envelope.chatType, envelope.chatId, envelope.senderId, envelope.messageId, at, new Date(Number.isFinite(after) ? after : 0), AGENT_CONTACT_CARD_LIMIT]);
  const cards = new Map<string, ContactCard>();
  for (const row of stored.rows) {
    const contact = parseStoredContact(row.content, row.raw);
    const when = new Date(row.occurred_at);
    if (contact && when.getTime() <= at.getTime() && when.getTime() > after) cards.set(row.message_id, { messageId: row.message_id, occurredAt: when, ...contact });
  }
  for (const other of batchEnvelopes) {
    if (other.messageId === envelope.messageId || other.kind !== 'contact' || !other.contact || cards.has(other.messageId)) continue;
    if (other.accountId !== envelope.accountId || other.chatType !== envelope.chatType || other.chatId !== envelope.chatId || other.senderId !== envelope.senderId) continue;
    const when = new Date(other.occurredAt);
    if (Number.isNaN(when.getTime()) || when.getTime() > at.getTime() || when.getTime() <= after) continue;
    const mid = text(other.contact.mid, 512);
    const displayName = text(other.contact.displayName, 128);
    if (mid || displayName) cards.set(other.messageId, { messageId: other.messageId, occurredAt: when, mid, displayName });
  }
  return [...cards.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.messageId.localeCompare(b.messageId)).slice(-AGENT_CONTACT_CARD_LIMIT);
}

/** The prompt of a text-triggered LINE job with its recent contact-card block. Only text messages carry cards. */
export async function promptWithContactCards(db: Queryable, envelope: InboundEnvelope, prompt: string, batchEnvelopes: readonly InboundEnvelope[] = []): Promise<string> {
  if (envelope.kind !== 'text') return prompt;
  const cards = await recentContactCards(db, envelope, batchEnvelopes);
  return cards.length === 0 ? prompt : `${prompt}\n\n${formatContactCardBlock(cards)}`;
}
