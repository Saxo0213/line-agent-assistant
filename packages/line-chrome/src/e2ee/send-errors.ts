// E2EE send-error classification. Port of OkLine okline/e2ee.py:68-79 (E2EE_RETRY_CODES) and :667-710 (send_with_retry).
// This module only CLASSIFIES; the retry itself (once per send, under a fresh single-use permit, ruling 7) happens in
// the send path (step 6).

import { ChromeApiError } from '../errors.js';

export const E2EE_ERROR_CODE = {
  /** The server rejected a plain send: seal and resend (OkLine messaging.py:46-58). */
  RETRY_ENCRYPT: 82,
  UPDATE_RECEIVER_KEY: 84,
  INVALID_VERSION: 86,
  SENDER_DISABLED: 87,
  RECEIVER_DISABLED: 88,
  /** E2EE_SENDER_NOT_ALLOWED: the extension disables E2EE on it; it is NOT a retry code. */
  SENDER_NOT_ALLOWED: 89,
  RECEIVER_NOT_ALLOWED: 90,
  RECREATE_GROUP_KEY: 99,
  REFRESH_MEDIA_FLOW: 122,
} as const;

/** Codes that reset the cached negotiation and retry the sealed send (OkLine `E2EE_RETRY_CODES`). */
export const E2EE_RENEGOTIATE_CODES: ReadonlySet<number> = new Set([84, 86, 87, 88, 90]);

export type E2eeSendErrorClass =
  /** 84/86/87/88/90: reset the chat's E2EE state, then retry once. */
  | { readonly kind: 'renegotiate'; readonly code: number }
  /** 99: reset, re-register the group key for group targets, then retry once. */
  | { readonly kind: 'recreate-group-key'; readonly code: number }
  /** 122: reset the cached negotiation and surface the error WITHOUT retrying (OkLine :696-699). */
  | { readonly kind: 'refresh-media-flow'; readonly code: number }
  | { readonly kind: 'other'; readonly code: number | undefined };

export function classifyE2eeSendError(error: unknown): E2eeSendErrorClass {
  const code = error instanceof ChromeApiError ? (error.code ?? error.innerCode) : undefined;
  if (code === E2EE_ERROR_CODE.REFRESH_MEDIA_FLOW) return { kind: 'refresh-media-flow', code };
  if (code === E2EE_ERROR_CODE.RECREATE_GROUP_KEY) return { kind: 'recreate-group-key', code };
  if (code !== undefined && E2EE_RENEGOTIATE_CODES.has(code)) return { kind: 'renegotiate', code };
  return { kind: 'other', code };
}

/** True when the classification allows exactly one retry of the sealed send. */
export function isRetryableE2eeSendError(cls: E2eeSendErrorClass): boolean {
  return cls.kind === 'renegotiate' || cls.kind === 'recreate-group-key';
}
