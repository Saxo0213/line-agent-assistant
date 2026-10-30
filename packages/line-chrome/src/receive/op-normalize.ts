// Chrome operation -> worker sync items. Mirrors what packages/line-worker/src/linejs-adapter.ts `sync()` (:1076-1139)
// hands to `normalizeOperation`, so the shared worker loop, DB and Agent flow stay unchanged:
//   - a message operation becomes `{...operation, message}` (decrypted), or `{operation, decryptionError}` on failure;
//   - op 55 NOTIFIED_READ_MESSAGE becomes a read receipt (same validation as `#collectReadReceipt`) and may name a chat
//     we have not seen, which the adapter catches up once via getRecentMessagesV2 (`catchupChatIds`).
// The shapes are copied, not imported: this package does not depend on line-worker.

import { isE2eeMessage, type ChromeMessage } from '../e2ee/framing.js';
import { OP_TYPE, type ChromeOperation } from './types.js';

/** `SyncResult` of the worker loop (worker-loop.ts:22-23), shape-compatible. */
export interface ChromeTalkCursor {
  version: 1;
  revision: string;
  globalRev: string;
  individualRev: string;
}

export interface ChromeDecryptionFailure {
  code: 'MISSING_E2EE_KEY';
  retryable: false;
}

export type ChromeSyncItem = unknown | { operation: unknown; source?: 'live' | 'history'; decryptionError?: ChromeDecryptionFailure };

export interface ChromeReadReceipt {
  chatId: string;
  readerMid: string;
  messageId: string;
  readAt: string;
}

export interface ChromeSyncResult {
  cursorAfter: ChromeTalkCursor;
  operations: ChromeSyncItem[];
  readReceipts?: ChromeReadReceipt[];
  /** Chats first sighted through a read receipt; the adapter fetches their recent messages once (cap 5 x 20). */
  catchupChatIds: string[];
}

export interface ChromeMessageDecryptor {
  decrypt(message: ChromeMessage): Promise<ChromeMessage>;
}

/** In-memory drop counters, same meaning as the linejs adapter's `readReceiptCounters`. */
export interface ReadReceiptCounters {
  readReceiptShapeDropped: number;
  readReceiptOverflowDropped: number;
}

export interface BuildSyncOptions {
  operations: readonly ChromeOperation[];
  /** Decimal revision to report as `cursorAfter.revision`. */
  cursorAfter: string;
  decryptor: ChromeMessageDecryptor;
  ownMid: string | null;
  /** Conversation ids already seen; updated in place (linejs-adapter `#seenConversationIds`). */
  seenConversationIds: Set<string>;
  counters?: ReadReceiptCounters;
}

const MAX_RECEIPTS = 500;
const OP_NAMES: Readonly<Record<string, number>> = {
  SEND_MESSAGE: OP_TYPE.SEND_MESSAGE,
  RECEIVE_MESSAGE: OP_TYPE.RECEIVE_MESSAGE,
  NOTIFIED_READ_MESSAGE: OP_TYPE.NOTIFIED_READ_MESSAGE,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Numeric op type; the stream sends numbers, but a numeric string or a known name is accepted too. */
export function operationType(op: ChromeOperation): number | null {
  const t = op.type;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    if (/^[0-9]{1,4}$/.test(t)) return Number(t);
    return OP_NAMES[t] ?? null;
  }
  return null;
}

export function chromeCursor(revision: string): ChromeTalkCursor {
  return { version: 1, revision, globalRev: '0', individualRev: '0' };
}

export async function buildChromeSyncResult(options: BuildSyncOptions): Promise<ChromeSyncResult> {
  const { decryptor, ownMid, seenConversationIds } = options;
  const counters = options.counters ?? { readReceiptShapeDropped: 0, readReceiptOverflowDropped: 0 };
  const operations: ChromeSyncItem[] = [];
  const catchupChatIds: string[] = [];
  const receipts = new Map<string, { chatId: string; readerMid: string; messageId: bigint; createdTime: number }>();

  for (const operation of options.operations) {
    const type = operationType(operation);
    // Every operation that carries a message is normalised, not only types 25 and 26 (linejs-adapter.ts:1091-1106).
    if (isRecord(operation.message)) {
      try {
        const message = isE2eeMessage(operation.message) ? await decryptor.decrypt(operation.message) : operation.message;
        operations.push({ ...operation, message });
        const from = typeof message.from === 'string' ? message.from : null;
        const to = typeof message.to === 'string' ? message.to : null;
        const chatId = to === ownMid ? from : to;
        if (chatId) seenConversationIds.add(chatId);
      } catch {
        // linejs-adapter.ts:1105-1108: any decrypt failure is a missing key, not retryable.
        operations.push({ operation, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } });
      }
    } else if (type === OP_TYPE.NOTIFIED_READ_MESSAGE) {
      collectReadReceipt(operation, ownMid, receipts, counters);
      const chat = operation.param1;
      if (typeof chat === 'string' && /^[ucr]/.test(chat) && !seenConversationIds.has(chat)) {
        seenConversationIds.add(chat);
        catchupChatIds.push(chat);
      }
    }
  }

  const readReceipts = [...receipts.values()].map((r) => ({
    chatId: r.chatId,
    readerMid: r.readerMid,
    messageId: r.messageId.toString(),
    readAt: new Date(r.createdTime).toISOString(),
  }));
  return {
    cursorAfter: chromeCursor(options.cursorAfter),
    operations,
    ...(readReceipts.length === 0 ? {} : { readReceipts }),
    catchupChatIds,
  };
}

/** linejs-adapter.ts `#collectReadReceipt` (:1146-1175), unchanged validation. */
function collectReadReceipt(
  value: ChromeOperation,
  ownMid: string | null,
  receipts: Map<string, { chatId: string; readerMid: string; messageId: bigint; createdTime: number }>,
  counters: ReadReceiptCounters,
): void {
  const createdTime =
    typeof value.createdTime === 'string' && /^[0-9]{1,15}$/.test(value.createdTime) ? Number(value.createdTime) : value.createdTime;
  const param3 = typeof value.param3 === 'bigint' ? value.param3.toString() : value.param3;
  if (
    typeof value.param1 !== 'string' ||
    !/^[ucr][0-9a-f]{32}$/.test(value.param1) ||
    typeof value.param2 !== 'string' ||
    !/^u[0-9a-f]{32}$/.test(value.param2) ||
    typeof param3 !== 'string' ||
    !/^[0-9]{1,20}$/.test(param3) ||
    typeof createdTime !== 'number' ||
    !Number.isSafeInteger(createdTime) ||
    createdTime <= 0 ||
    Number.isNaN(new Date(createdTime).getTime())
  ) {
    counters.readReceiptShapeDropped += 1;
    return;
  }
  if (value.param2 === ownMid) return;
  const key = `${value.param1}|${value.param2}`;
  const messageId = BigInt(param3);
  const existing = receipts.get(key);
  if (existing) {
    if (messageId > existing.messageId) receipts.set(key, { ...existing, messageId, createdTime });
    return;
  }
  if (receipts.size >= MAX_RECEIPTS) {
    counters.readReceiptOverflowDropped += 1;
    return;
  }
  receipts.set(key, { chatId: value.param1, readerMid: value.param2, messageId, createdTime });
}

/**
 * Catch-up helper for the adapter: `getRecentMessagesV2` rows (newest first) become oldest-first `history` items, each
 * decrypted; one that cannot be decrypted is skipped, never faked (linejs-adapter.ts:1125-1135).
 */
export async function buildCatchupItems(messages: readonly unknown[], decryptor: ChromeMessageDecryptor): Promise<ChromeSyncItem[]> {
  const items: ChromeSyncItem[] = [];
  for (const raw of [...messages].reverse()) {
    if (!isRecord(raw)) continue;
    try {
      const message = isE2eeMessage(raw) ? await decryptor.decrypt(raw) : raw;
      items.push({ source: 'history', operation: { revision: message.id, message } });
    } catch {
      /* unavailable E2EE history is not a fake message */
    }
  }
  return items;
}
