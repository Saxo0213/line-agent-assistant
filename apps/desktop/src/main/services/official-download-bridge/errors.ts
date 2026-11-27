// Typed error for the official download bridge. The code is the real failure stage. Do not map it to a generic code.

import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';

export type BridgeErrorCode =
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_VERSION_MISMATCH'
  | 'EXTENSION_COPY_FAILED'
  | 'CHROME_NOT_FOUND'
  | 'CHROME_START_FAILED'
  | 'CDP_TIMEOUT'
  | 'CDP_CLOSED'
  | 'CHROME_EXITED_AT_START'
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

const SAFE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{1,63}$/;

/**
 * Audit detail of any error of the bridge path. Order: code plus reason slug (BridgeError with a reason),
 * `code:<CODE>` (BridgeError, BridgeDownloadError or another error with a code), `class:<name>` (an error without a code).
 * It matches `^[A-Za-z0-9_.:-]{1,160}$` and holds no path.
 */
export function bridgeErrorDetail(error: unknown): string | undefined {
  const reason = bridgeFailureDetail(error);
  if (reason) return reason;
  let code: unknown;
  let name: unknown;
  try {
    if (error && typeof error === 'object') {
      code = (error as { code?: unknown }).code;
      name = (error as { name?: unknown }).name;
    }
  } catch { /* A hostile getter is not evidence. */ }
  if (typeof code === 'string' && SAFE_CODE_PATTERN.test(code)) return `code:${code}`;
  if (typeof name === 'string') {
    const slug = name.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60);
    if (slug) return `class:${slug}`;
  }
  return undefined;
}

/**
 * Safe diagnostic of a failure on the bridge path. It adds the real code to the detail and picks a matching category
 * when the base category is `unknown`.
 */
export function bridgeDiagnosticFailure(operation: SafeDiagnostic['operation'], stage: SafeDiagnostic['stage'], error?: unknown): SafeDiagnostic {
  const base = diagnosticFailure(operation, stage, error);
  const detail = bridgeErrorDetail(error);
  const code = error instanceof BridgeError ? error.code : (error as { code?: unknown } | null | undefined)?.code;
  const category: SafeDiagnostic['category'] = base.category !== 'unknown' ? base.category
    : code === 'BRIDGE_NOT_LOGGED_IN' || code === 'BRIDGE_NOT_READY' ? 'authentication_required'
      : code === 'CDP_TIMEOUT' ? 'timeout' : code === 'CDP_CLOSED' || code === 'CHROME_EXITED_AT_START' || code === 'CHROME_NOT_FOUND' ? 'unavailable'
        : code === 'CHROME_START_FAILED' ? 'process_start_failed' : code === 'CDP_ERROR' ? 'transport_failed' : 'unknown';
  return { ...base, category, ...(detail ? { detail } : {}),
    recovery: category === 'authentication_required' ? 'relogin' : category === base.category ? base.recovery : category === 'unavailable' ? 'check_configuration' : 'retry' };
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  /** Names of variables that were missing (EXTENSION_HANDLES_NOT_FOUND only). */
  readonly missing: readonly string[];
  /** Safe text of the external message (see `safeReasonText`). Only for codes whose message comes from Chrome or CDP. */
  readonly reason: string | undefined;

  constructor(code: BridgeErrorCode, message: string, options: { cause?: unknown; missing?: readonly string[]; paths?: readonly string[]; exposeReason?: boolean } = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.missing = options.missing ?? [];
    // `exposeReason`: the caller made the message from known values (for example the exit code of Chrome).
    this.reason = EXTERNAL_MESSAGE_CODES.has(code) || options.exposeReason ? safeReasonText(message, options.paths) || undefined : undefined;
  }
}
