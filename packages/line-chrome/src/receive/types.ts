// Shared receive-side types and precision-safe revision helpers.

/** Numeric Operation types the transport acts on (OkLine enums.py OpType). */
export const OP_TYPE = {
  SEND_MESSAGE: 25,
  RECEIVE_MESSAGE: 26,
  NOTIFIED_READ_MESSAGE: 55,
} as const;

/**
 * An Operation as it arrives on the SSE stream: Thrift field names and numeric enums. Revisions and ids that exceed 2^53
 * are decimal strings (the precise JSON parser); everything else is a plain number.
 */
export interface ChromeOperation {
  revision?: number | string;
  createdTime?: number | string;
  type?: number | string;
  reqSeq?: number | string;
  checksum?: string;
  status?: number | string;
  param1?: unknown;
  param2?: unknown;
  param3?: unknown;
  message?: Record<string, unknown>;
  [field: string]: unknown;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** A non-negative decimal revision as bigint, or null when the value is not one (unsafe numbers are rejected). */
export function toRevision(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && DECIMAL.test(value)) return BigInt(value);
  return null;
}

/** Operation revisions the stream can use for ordering: positive. */
export function opRevision(op: ChromeOperation): bigint | null {
  const rev = toRevision(op.revision);
  return rev !== null && rev > 0n ? rev : null;
}
