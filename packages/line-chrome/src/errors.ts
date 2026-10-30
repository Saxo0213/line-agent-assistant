// Typed errors and gateway error classification.
// Ported from OkLine okline/exceptions.py and okline/transport.py:92-131 (codes, scope) and :428-439, :507-549.

import { isTalkAuthScoped, specialPath } from './endpoints.js';
import { pythonTruthy } from './json.js';

/** Gateway envelope codes (the extension's `qU` enum). */
export const ENVELOPE_CODE = {
  /** X-Hmac missing or rejected. Not classified by OkLine's transport; documented in OkLine's errors reference. */
  INVALID_HMAC: 10005,
  REQUEST_MUST_UPGRADE: 10006,
  RESPONSE_HTTP_ERROR: 10052,
  /** tokenRefresh: the refresh token is dead; kick the session out. */
  AUTH_INVALID_REQUEST: 10201,
  /** tokenRefresh: retry per refreshApiRetryPolicy. */
  AUTH_RETRY_REQUIRED: 10202,
  UNKNOWN_ERROR: 99999,
} as const;

/** TalkException codes (the extension's `mU` enum) the gateway layer reacts to. */
export const TALK_CODE = {
  AUTHENTICATION_FAILED: 1,
  NOT_AVAILABLE_USER: 7,
  NOT_AUTHORIZED_DEVICE: 8,
  SHOULD_RETRY: 115,
  MUST_REFRESH_V3_TOKEN: 119,
} as const;

/** Inner codes that kick the session out when raised inside the talk-auth scope (OkLine exceptions.py `_AUTH_CODES`). */
export const AUTH_KICKOUT_CODES: ReadonlySet<number> = new Set([1, 7, 8]);

export interface GatewayErrorDetails {
  code?: number | undefined;
  reason?: string | undefined;
  metadata?: unknown;
  path?: string | undefined;
  status?: number | undefined;
  raw?: unknown;
  /** Outer envelope code (10006/10052/99999/...), when the body carried one. */
  outerCode?: number | undefined;
  /** TalkException code nested in `data`, when present. */
  innerCode?: number | undefined;
}

/** Base of every error raised by this package. */
export class ChromeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Misconfiguration or caller misuse (never a network event). */
export class ChromeConfigError extends ChromeError {}

/** No usable credentials: the call needs an access token and there is none. */
export class ChromeLoginRequiredError extends ChromeError {
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message);
    this.path = path;
  }
}

/**
 * Network or timeout failure. For a write, `outcomeUnknown` is true: the request may have reached LINE, so the caller
 * must report it as unknown-outcome and never replay it automatically.
 */
export class ChromeTransportError extends ChromeError {
  readonly outcomeUnknown: boolean;
  readonly timedOut: boolean;
  readonly status: number | undefined;
  constructor(
    message: string,
    options: { outcomeUnknown: boolean; timedOut?: boolean; status?: number | undefined; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.outcomeUnknown = options.outcomeUnknown;
    this.timedOut = options.timedOut ?? false;
    this.status = options.status;
  }
}

/** A failure reported by the gateway (HTTP error, non-OK envelope or Thrift application exception). */
export class ChromeApiError extends ChromeError {
  readonly code: number | undefined;
  readonly reason: string | undefined;
  readonly metadata: unknown;
  readonly path: string | undefined;
  readonly status: number | undefined;
  readonly raw: unknown;
  readonly outerCode: number | undefined;
  readonly innerCode: number | undefined;
  constructor(message: string, details: GatewayErrorDetails = {}) {
    super(message);
    this.code = details.code;
    this.reason = details.reason;
    this.metadata = details.metadata;
    this.path = details.path;
    this.status = details.status;
    this.raw = details.raw;
    this.outerCode = details.outerCode;
    this.innerCode = details.innerCode;
  }
}

/** Authentication problem. Subclasses say which. */
export class ChromeAuthError extends ChromeApiError {}

/** Inner TalkException 1/7/8 inside the talk-auth scope, or HTTP 401/403: the session is dead (OkLine LineAuthError). */
export class ChromeAuthKickoutError extends ChromeAuthError {}

/** Inner 119: the V3 token must be refreshed. Surfaces only when no hook is wired, the refresh failed, or the call was a write. */
export class ChromeMustRefreshTokenError extends ChromeAuthError {}

/** Envelope 10006: the server demands a newer client version. */
export class ChromeMustUpgradeError extends ChromeApiError {}

/** Envelope 10005: X-Hmac was rejected. */
export class ChromeInvalidHmacError extends ChromeApiError {}

/** Envelope 10201 from tokenRefresh: the refresh token is invalid; the session must be invalidated. */
export class ChromeRefreshKickoutError extends ChromeAuthError {}

/** Envelope 10202 from tokenRefresh: retry according to the refreshApiRetryPolicy. */
export class ChromeRefreshRetryError extends ChromeApiError {}

/**
 * Retryable envelope 99999 or inner 115 (SHOULD_RETRY). The gateway client retries these for reads only; when the
 * budget is spent, or for writes, the error escapes as this class (OkLine hides its internal marker; a public class
 * lets a caller tell "gateway said retry" from other API errors).
 */
export class ChromeRetryableApiError extends ChromeApiError {}

export interface ClassifyOptions {
  path: string;
  /** HTTP status of the response. */
  status: number;
  /** Decoded JSON body (precision-safe), or the raw text when it was not JSON. */
  payload: unknown;
  /** Extension flag `ignoreTalkAuthException`. */
  ignoreAuthException?: boolean;
  /** Extension flag `ignoreMustUpgrade`. */
  ignoreMustUpgrade?: boolean;
}

export interface ErrorInfo {
  outerCode: number | undefined;
  innerCode: number | undefined;
  /** Code to surface: the inner TalkException, else the outer envelope code. */
  code: number | undefined;
  reason: string | undefined;
  metadata: unknown;
  /** Status override (10052's nested statusCode). */
  status: number | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Python `isinstance(x, int)` accepts bool, so true is 1 and false is 0 (OkLine transport.py:876-878).
const asCode = (v: unknown): number | undefined => v === true ? 1 : v === false ? 0 : typeof v === 'number' && Number.isInteger(v) ? v : undefined;
const firstString = (...values: unknown[]): string | undefined => {
  for (const v of values) if (typeof v === 'string' && v !== '') return v;
  return undefined;
};

/**
 * Pull the outer envelope code, nested TalkException code/reason and metadata out of an error body
 * (OkLine transport.py `_extract_error`). Shapes on the wire:
 *   {"code":10051,"message":"RESPONSE_ERROR","data":{"name":"TalkException","code":82,"reason":"..."}}
 *   {"message":"FAILED","error":{"code":20,"message":"bad request"}}
 * For envelope 10052 the meaningful HTTP status is nested in `data.statusCode` (e.g. 410) and is surfaced as the
 * code and the status; `rejectionReason` is merged into the metadata.
 */
export function extractErrorInfo(payload: unknown): ErrorInfo {
  let outer: number | undefined;
  let inner: number | undefined;
  let code: number | undefined;
  let reason: string | undefined;
  let meta: unknown;
  let nested: unknown;
  let status: number | undefined;
  if (isRecord(payload)) {
    const err = 'error' in payload ? payload.error : payload;
    if (isRecord(err)) {
      // Python `err.get("code", err.get("statusCode"))`: statusCode is used only when the key `code` is absent.
      code = 'code' in err ? asCode(err.code) : asCode(err.statusCode);
      reason = firstString(err.message, err.reason, err.debugMessage);
      meta = pythonTruthy(err.metadata) ? err.metadata : err.parameterMap;
      nested = err.data;
      if (isRecord(nested) && (nested.code !== undefined && nested.code !== null || pythonTruthy(nested.reason))) {
        const nestedCode = asCode(nested.code);
        if (nestedCode !== undefined) {
          inner = nestedCode;
          code = nestedCode;
        }
        reason = firstString(nested.reason, nested.alertMessage, nested.message, reason);
        meta = (pythonTruthy(nested.parameterMap) ? nested.parameterMap : undefined) ?? (pythonTruthy(nested.metadata) ? nested.metadata : undefined) ?? meta;
      }
    }
    let rawOuter = asCode(payload.code);
    if (rawOuter === undefined && isRecord(payload.error)) rawOuter = asCode(payload.error.code);
    outer = rawOuter;
    if (outer === ENVELOPE_CODE.RESPONSE_HTTP_ERROR && isRecord(nested)) {
      const statusCode = asCode(nested.statusCode);
      if (statusCode !== undefined) {
        code = statusCode;
        status = statusCode;
      }
      if (nested.rejectionReason !== undefined && nested.rejectionReason !== null) {
        meta = { ...(isRecord(meta) ? meta : {}), rejectionReason: nested.rejectionReason };
      }
    }
  }
  return { outerCode: outer, innerCode: inner, code, reason, metadata: meta, status };
}

/**
 * Turn a failed gateway response into the matching typed error (OkLine transport.py:507-549, following the extension's
 * interceptor chain). Order matters and mirrors OkLine:
 *  1. envelope 10006 (not path-scoped; opt-out via ignoreMustUpgrade)
 *  2. envelope 10201 / 10202 (tokenRefresh) and 10005 (invalid hmac)   [added: spec lists them; they are outer codes]
 *  3. inner 119 inside the talk-auth scope (opt-out via ignoreAuthException)
 *  4. HTTP 401/403, or inner 1/7/8 inside the talk-auth scope: kickout
 *  5. envelope 99999 or inner 115: retryable
 *  6. anything else: plain API error
 */
export function classifyGatewayError(options: ClassifyOptions): ChromeApiError {
  const { path, status, payload } = options;
  const info = extractErrorInfo(payload);
  const message =
    info.reason ??
    (status >= 200 && status < 300 ? `gateway response without OK envelope for ${path}` : `HTTP ${status} for ${path}`);
  const details: GatewayErrorDetails = {
    code: info.code,
    reason: info.reason,
    metadata: info.metadata,
    path,
    status: info.status ?? status,
    raw: payload,
    outerCode: info.outerCode,
    innerCode: info.innerCode,
  };
  const talkAuth = isTalkAuthScoped(path) && !options.ignoreAuthException;

  // OkLine auth.py:1063-1071 reads `exc.code` of the tokenRefresh error: the nested TalkException code when the body nests one
  // (transport.py:876-878), else the envelope code (:864). No other path interprets 10201 or 10202 (transport.py:797-823).
  // It runs before the upgrade test: OkLine raises LineMustUpgradeError there, and auth.py:1064 still reads its code.
  if (path === specialPath('auth.tokenRefresh')) {
    if (info.code === ENVELOPE_CODE.AUTH_INVALID_REQUEST) return new ChromeRefreshKickoutError(message, details);
    if (info.code === ENVELOPE_CODE.AUTH_RETRY_REQUIRED) return new ChromeRefreshRetryError(message, details);
  }
  if (info.outerCode === ENVELOPE_CODE.REQUEST_MUST_UPGRADE || (info.reason ?? '').toUpperCase().includes('UPGRADE')) {
    // The ONLY upgrade trigger is the outer envelope code 10006. Inner 86 is E2EE_INVALID_VERSION, not an upgrade.
    if (!options.ignoreMustUpgrade) return new ChromeMustUpgradeError(message, details);
  }
  if (info.outerCode === ENVELOPE_CODE.INVALID_HMAC) return new ChromeInvalidHmacError(message, details);
  if (talkAuth && info.innerCode === TALK_CODE.MUST_REFRESH_V3_TOKEN) {
    return new ChromeMustRefreshTokenError(message, details);
  }
  if (status === 401 || status === 403 || (talkAuth && info.code !== undefined && AUTH_KICKOUT_CODES.has(info.code))) {
    return new ChromeAuthKickoutError(message, details);
  }
  if (info.outerCode === ENVELOPE_CODE.UNKNOWN_ERROR || info.innerCode === TALK_CODE.SHOULD_RETRY) {
    return new ChromeRetryableApiError(message, details);
  }
  return new ChromeApiError(message, details);
}

/** True for errors that mean the stored session can no longer authenticate (kickout or refresh-token death). */
export function isSessionKickout(error: unknown): boolean {
  return error instanceof ChromeAuthKickoutError || error instanceof ChromeRefreshKickoutError;
}

/** An E2EE field is invalid, or the E2EE state cannot do the requested step. */
export class ChromeE2eeError extends ChromeError {}

/** Property key that carries the last login step on a thrown error. The worker reads it by this name. */
export const LOGIN_STAGE_KEY = 'loginStage';

/** Record the login step on a thrown error. The first tag stays. A value that is not an object is ignored. */
export function tagLoginStage(error: unknown, stage: string): void {
  if (typeof error !== 'object' || error === null || Object.hasOwn(error, LOGIN_STAGE_KEY)) return;
  try {
    Object.defineProperty(error, LOGIN_STAGE_KEY, { value: stage, enumerable: false, configurable: true });
  } catch { /* A frozen error keeps no tag. */ }
}
