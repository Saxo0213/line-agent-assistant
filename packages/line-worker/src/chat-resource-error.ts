export const CHAT_RESOURCE_FAILURE_CATEGORIES = [
  'bootstrap_failure', 'list_get_transport_failure', 'response_code_invalid', 'response_shape_invalid',
  'normalization_failure', 'response_validation', 'timeout', 'cancellation', 'unknown',
] as const;

export type ChatResourceFailureCategory = typeof CHAT_RESOURCE_FAILURE_CATEGORIES[number];
export type ChatResourceResponseCode = number | 'missing' | 'non_numeric';
export const CHAT_RESOURCE_FAILURE_KINDS = ['linejs_internal', 'effect_denied', 'type_error', 'range_error', 'timeout_error', 'abort_error', 'other'] as const;
export type ChatResourceFailureKind = typeof CHAT_RESOURCE_FAILURE_KINDS[number];

export function safeChatResourceFailureKind(error: unknown): ChatResourceFailureKind {
  try { if (error && typeof error === 'object') {
    const value = error as { name?: unknown; type?: unknown };
    if (value.type === 'MoaError') return 'linejs_internal';
    if (value.name === 'EffectDeniedError') return 'effect_denied';
    if (value.name === 'TypeError') return 'type_error';
    if (value.name === 'RangeError') return 'range_error';
    if (value.name === 'TimeoutError') return 'timeout_error';
    if (value.name === 'AbortError') return 'abort_error';
  } } catch { /* A hostile error getter is reduced to the generic safe kind. */ }
  return 'other';
}

export function safeChatResourceUpstreamNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

export function safeChatResourceUpstreamCode(value: unknown): ChatResourceResponseCode {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000
    ? value : 'non_numeric';
}

export function safeChatResourceFailureDetails(error: unknown): Readonly<{ failureKind: ChatResourceFailureKind;
  upstreamStatus?: number; upstreamCode?: ChatResourceResponseCode }> {
  const failureKind = safeChatResourceFailureKind(error);
  try {
    if (!error || typeof error !== 'object') return { failureKind };
    const data = (error as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { failureKind };
    const fields = data as Record<string, unknown>;
    const upstreamStatus = safeChatResourceUpstreamNumber(fields.status);
    return { failureKind, ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      ...(!Object.hasOwn(fields, 'code') ? {} : { upstreamCode: safeChatResourceUpstreamCode(fields.code) }) };
  } catch { return { failureKind }; }
}

export class ChatResourceFailure extends Error {
  constructor(readonly category: ChatResourceFailureCategory, readonly responseCode?: ChatResourceResponseCode,
    readonly failureKind?: ChatResourceFailureKind, readonly upstreamStatus?: number, readonly upstreamCode?: ChatResourceResponseCode) {
    super(category);
    this.name = 'ChatResourceFailure';
  }
}

export function boundedChatResourceResponseCode(value: unknown, present: boolean): ChatResourceResponseCode {
  if (!present) return 'missing';
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000
    ? value : 'non_numeric';
}

export function isChatResourceFailure(error: unknown): error is ChatResourceFailure {
  return error instanceof ChatResourceFailure && CHAT_RESOURCE_FAILURE_CATEGORIES.includes(error.category);
}

/**
 * The transport has no way to serve this chat-resource action (the CHROMEOS profile has no notes API and no album list).
 * The worker loop reports it as the stable `UNSUPPORTED` error, the same one it emits for a transport without
 * `readChatResource`, so Main and the renderer see one code for "this login method does not support it".
 */
export class ChatResourceUnsupportedError extends Error {
  readonly code = 'UNSUPPORTED';
  constructor() { super('UNSUPPORTED'); this.name = 'ChatResourceUnsupportedError'; }
}

export function isChatResourceUnsupported(error: unknown): error is ChatResourceUnsupportedError {
  return error instanceof ChatResourceUnsupportedError;
}
