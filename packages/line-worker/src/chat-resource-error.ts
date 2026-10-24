export const CHAT_RESOURCE_FAILURE_CATEGORIES = [
  'bootstrap_failure', 'list_get_transport_failure', 'response_code_invalid', 'response_shape_invalid',
  'normalization_failure', 'response_validation', 'timeout', 'cancellation', 'unknown',
] as const;

export type ChatResourceFailureCategory = typeof CHAT_RESOURCE_FAILURE_CATEGORIES[number];
export type ChatResourceResponseCode = number | 'missing' | 'non_numeric';

export class ChatResourceFailure extends Error {
  constructor(readonly category: ChatResourceFailureCategory, readonly responseCode?: ChatResourceResponseCode) {
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
