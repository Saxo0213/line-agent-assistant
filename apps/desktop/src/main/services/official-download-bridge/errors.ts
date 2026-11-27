// Typed error for the official download bridge. The code is the real failure stage. Do not map it to a generic code.

export type BridgeErrorCode =
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_VERSION_MISMATCH'
  | 'EXTENSION_COPY_FAILED'
  | 'CHROME_NOT_FOUND'
  | 'CHROME_START_FAILED'
  | 'CDP_TIMEOUT'
  | 'CDP_CLOSED'
  | 'CDP_ERROR'
  | 'EXTENSION_LOAD_FAILED'
  | 'EXTENSION_STORE_INSTALL_REQUIRED'
  | 'EXTENSION_FEATURES_CHANGED'
  | 'EXTENSION_ID_MISMATCH'
  | 'EXTENSION_PAGE_FAILED'
  | 'EXTENSION_HANDLES_NOT_FOUND';

/** Codes whose message comes from Chrome or CDP. Only these codes carry a safe reason. */
const EXTERNAL_MESSAGE_CODES: ReadonlySet<BridgeErrorCode> = new Set<BridgeErrorCode>([
  'CHROME_START_FAILED', 'CDP_ERROR', 'EXTENSION_LOAD_FAILED', 'EXTENSION_PAGE_FAILED', 'EXTENSION_COPY_FAILED',
  'EXTENSION_STORE_INSTALL_REQUIRED', 'EXTENSION_FEATURES_CHANGED',
]);
const MAX_SAFE_REASON = 160;
const MAX_REASON_DETAIL = 160;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reduces an external error message to a short safe text. File system paths (they hold the user name) become `<path>`.
 * The result keeps only the characters [A-Za-z0-9 .,:;_()'-], one space at most between words, 160 characters at most.
 */
export function safeReasonText(message: string, paths: readonly string[] = []): string {
  let text = message;
  // Longest known path first. Both slash forms match.
  for (const path of [...paths].filter((p) => p.length > 0).sort((a, b) => b.length - a.length)) {
    const pattern = escapeRegExp(path).replace(/\\\\|\//g, '[\\\\/]');
    text = text.replace(new RegExp(pattern, 'gi'), '<path>');
  }
  text = text
    .replace(/[A-Za-z]:[\\/][^\s"'<>|*?]*/g, '<path>')
    .replace(/\\\\[^\s"'<>|*?]+/g, '<path>')
    .replace(/^(?:[A-Z][A-Z_]+:\s+)+/, '');
  return text.replace(/<path>/g, ' PATHTOKEN9 ').replace(/[^A-Za-z0-9 .,:;_()'-]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/PATHTOKEN9/g, '<path>').slice(0, MAX_SAFE_REASON);
}

/**
 * Audit detail of a bridge failure, for example `code:EXTENSION_LOAD_FAILED:reason:Failed_to_load_extension`.
 * It matches `^[A-Za-z0-9_.:-]{1,160}$` (the audit trigger and the IPC status detail allow only these characters).
 * Returns undefined when the error carries no reason.
 */
export function bridgeFailureDetail(error: unknown): string | undefined {
  if (!(error instanceof BridgeError) || !error.reason) return undefined;
  const slug = error.reason.replace(/ /g, '_').replace(/[^A-Za-z0-9_.:-]/g, '');
  return slug ? `code:${error.code}:reason:${slug}`.slice(0, MAX_REASON_DETAIL) : undefined;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  /** Names of variables that were missing (EXTENSION_HANDLES_NOT_FOUND only). */
  readonly missing: readonly string[];
  /** Safe text of the external message (see `safeReasonText`). Only for codes whose message comes from Chrome or CDP. */
  readonly reason: string | undefined;

  constructor(code: BridgeErrorCode, message: string, options: { cause?: unknown; missing?: readonly string[]; paths?: readonly string[] } = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.missing = options.missing ?? [];
    this.reason = EXTERNAL_MESSAGE_CODES.has(code) ? safeReasonText(message, options.paths) || undefined : undefined;
  }
}
