// Read receipts and unsends from the Talk operations that the linejs listener delivered.
// The rules and the output shape follow the LINE operation types. This file sends nothing to LINE.

export type ReadReceipt = Readonly<{ chatId: string; readerMid: string; messageId: string; readAt: string }>;
export type UnsendNotice = Readonly<{ chatId: string; messageId: string; kind: 'self' | 'notified'; observedAt: string }>;
type OperationLike = { type?: unknown; param1?: unknown; param2?: unknown; param3?: unknown; createdTime?: unknown };

export const OPERATION_COLLECT_LIMIT = 500;

/** A LINE revision as a decimal string. It throws on an unsafe number. */
export function decimal(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('unsafe LINE cursor number');
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new TypeError('invalid LINE cursor');
  return text;
}

/** OpType 64 (DESTROY_MESSAGE) is the own account on another device; 65 (NOTIFIED_DESTROY_MESSAGE) is another member. */
export function unsendOperationKind(type: unknown): 'self' | 'notified' | null {
  if (type === 'DESTROY_MESSAGE' || type === 64) return 'self';
  if (type === 'NOTIFIED_DESTROY_MESSAGE' || type === 65) return 'notified';
  return null;
}

function createdMillis(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && /^[0-9]{1,15}$/.test(value) ? Number(value) : value;
}

export class OperationCollector {
  readonly counters = { unsendShapeDropped: 0, unsendOverflowDropped: 0, readReceiptShapeDropped: 0, readReceiptOverflowDropped: 0 };
  readonly #receipts = new Map<string, { chatId: string; readerMid: string; messageId: bigint; createdTime: number }>();
  readonly #unsends = new Map<string, UnsendNotice>();
  constructor(private readonly ownMid: () => string | undefined) {}

  add(operation: unknown): void {
    const value = operation as OperationLike;
    if (value.type === 'NOTIFIED_READ_MESSAGE') this.#receipt(value);
    const kind = unsendOperationKind(value.type);
    if (kind) this.#unsend(value, kind);
  }

  receipts(): ReadReceipt[] {
    return [...this.#receipts.values()].map((receipt) => ({ chatId: receipt.chatId, readerMid: receipt.readerMid,
      messageId: receipt.messageId.toString(), readAt: new Date(receipt.createdTime).toISOString() }));
  }
  unsends(): UnsendNotice[] { return [...this.#unsends.values()]; }
  /** Forget the collected items after one sync result took them. The drop counters stay. */
  reset(): void { this.#receipts.clear(); this.#unsends.clear(); }

  #unsend(value: OperationLike, kind: 'self' | 'notified'): void {
    const { param1: chatId, param2: messageId } = value;
    if (typeof chatId !== 'string' || !/^[ucr][0-9a-f]{32}$/.test(chatId)
      || typeof messageId !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(messageId) || BigInt(messageId) > 9223372036854775807n) {
      this.counters.unsendShapeDropped += 1;
      return;
    }
    const createdTime = createdMillis(value.createdTime);
    const observed = typeof createdTime === 'number' && Number.isSafeInteger(createdTime) && createdTime > 0
      ? new Date(createdTime) : new Date();
    const observedAt = Number.isNaN(observed.getTime()) ? new Date().toISOString() : observed.toISOString();
    const key = `${chatId}|${messageId}`;
    if (this.#unsends.has(key)) return;
    if (this.#unsends.size >= OPERATION_COLLECT_LIMIT) { this.counters.unsendOverflowDropped += 1; return; }
    this.#unsends.set(key, { chatId, messageId, kind, observedAt });
  }

  #receipt(value: OperationLike): void {
    const createdTime = createdMillis(value.createdTime);
    const param3 = typeof value.param3 === 'bigint' ? value.param3.toString() : value.param3;
    if (typeof value.param1 !== 'string' || !/^[ucr][0-9a-f]{32}$/.test(value.param1)
      || typeof value.param2 !== 'string' || !/^u[0-9a-f]{32}$/.test(value.param2)
      || typeof param3 !== 'string' || !/^[0-9]{1,20}$/.test(param3)
      || typeof createdTime !== 'number' || !Number.isSafeInteger(createdTime) || createdTime <= 0
      || Number.isNaN(new Date(createdTime).getTime())) {
      this.counters.readReceiptShapeDropped += 1;
      return;
    }
    if (value.param2 === this.ownMid()) return;
    const key = `${value.param1}|${value.param2}`;
    const messageId = BigInt(param3);
    const existing = this.#receipts.get(key);
    if (existing) {
      if (messageId > existing.messageId) this.#receipts.set(key, { ...existing, messageId, createdTime });
      return;
    }
    if (this.#receipts.size >= OPERATION_COLLECT_LIMIT) { this.counters.readReceiptOverflowDropped += 1; return; }
    this.#receipts.set(key, { chatId: value.param1, readerMid: value.param2, messageId, createdTime });
  }
}
