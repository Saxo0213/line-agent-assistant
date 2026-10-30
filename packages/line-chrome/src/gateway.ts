// Gateway client for https://line-chrome-gw.line-apps.com.
// Ported from OkLine okline/transport.py (Transport.base_headers :249-298, post_json :318-455, get :457-500,
// _decode/_extract_error :507-640). Differences from OkLine are listed in the step report and marked `DEVIATION`.

import {
  CHROME_EXTENSION_VERSION,
  CHROME_USER_AGENT,
  DEFAULT_LOCALE,
  DEFAULT_MAX_READ_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  GATEWAY_BASE_URL,
  lalForLocale,
} from './constants.js';
import { thriftPath, type ThriftEndpointKey } from './endpoints.js';
import {
  ChromeConfigError,
  ChromeLoginRequiredError,
  ChromeMustRefreshTokenError,
  ChromeRetryableApiError,
  ChromeTransportError,
  classifyGatewayError,
} from './errors.js';
import { parsePreciseJson } from './json.js';
import type { HmacSigner } from './signer.js';

/** The caller states whether a call mutates server state. Writes are never retried or replayed automatically. */
export type CallMode = 'read' | 'write';

export type HeaderPairs = ReadonlyArray<readonly [string, string]>;

/** What is about to go on the wire. `beforeRequest` receives one per physical attempt (retries and replays included). */
export interface PhysicalRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** Path without query. */
  readonly path: string;
  /** What X-Hmac signs: `path` for POST, `path?query` for GET. */
  readonly pathWithQuery: string;
  /** Headers in exact wire order. */
  readonly headers: HeaderPairs;
  /** Exact UTF-8 body string for POST; undefined for GET. */
  readonly body: string | undefined;
  readonly mode: CallMode;
  /** Thrift endpoint key when the call came through `call()`. */
  readonly endpointKey: ThriftEndpointKey | undefined;
  /** 0-based attempt number within one execution (retries increase it). */
  readonly attempt: number;
  /** True for the single replay that follows an inner-119 token refresh. */
  readonly replay: boolean;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GatewayOptions {
  /** Injected fetch (undici-compatible). Nothing else in this package touches the network. */
  fetch: FetchLike;
  signer: HmacSigner;
  /** Current access token; `undefined`/`""` before login. Read on every request so refreshes take effect. */
  getAccessToken: () => string | undefined;
  /** Channel token, attached as X-Line-ChannelToken to `/api/timeline/*` only. */
  getChannelToken?: () => string | undefined;
  /**
   * Called on inner TalkException 119 (reads only). Resolve true when the token was renewed; the request is then
   * replayed exactly once with fresh signature and token. Resolve false/reject to surface the 119 error.
   */
  onMustRefresh?: () => Promise<boolean>;
  /** Hook run before every physical request; throw to block it (the mutation gate in step 5). Blocking is never retried. */
  beforeRequest?: (request: PhysicalRequest) => void | Promise<void>;
  baseUrl?: string;
  locale?: string;
  userAgent?: string;
  /** Optional LEGY routing host, sent as `X-Legy-Host` (OkLine legy_host). */
  legyHost?: string;
  timeoutMs?: number;
  /** Transport-level retries for reads on 5xx/99999/115/network errors. OkLine max_retries. */
  maxReadRetries?: number;
  /** Delay between read retries; OkLine has none, so default 0. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  mode: CallMode;
  /** false for the login bootstrap: no X-Line-Access header. Default true. */
  requireAuth?: boolean;
  /** Appended after X-Hmac, in order, e.g. `X-Line-Session-ID` and `X-LST`. */
  extraHeaders?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extension flag `ignoreTalkAuthException`. */
  ignoreAuthException?: boolean;
  /** Extension flag `ignoreMustUpgrade`. */
  ignoreMustUpgrade?: boolean;
}

export interface GetOptions {
  requireAuth?: boolean;
  extraHeaders?: Readonly<Record<string, string>>;
  /** Applies until response headers arrive; the body (an SSE stream) is the caller's to read. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** false skips X-Hmac (OkLine `sign=False`). Default true. */
  sign?: boolean;
  /**
   * 'eventsource' sends the minimal header set OkLine uses for the SSE stream (operations.py:366-380; a real EventSource
   * cannot carry the custom X-* headers): accept, cache-control, Accept-Language, User-Agent, then X-Line-Access.
   * Default 'api' is the full gateway header set.
   */
  headerProfile?: 'api' | 'eventsource';
}

export type QueryParams = ReadonlyArray<readonly [string, string | number]> | Readonly<Record<string, string | number>>;

/**
 * Python `urllib.parse.urlencode` (quote_plus) equivalent, preserving parameter order. The signed `path?query` must be
 * byte-identical to the URL sent, so the same function builds both. Unreserved set: letters, digits, `_.-~`; space is `+`.
 */
export function encodeQuery(params: QueryParams): string {
  const pairs = Array.isArray(params) ? (params as ReadonlyArray<readonly [string, string | number]>) : Object.entries(params);
  return pairs.map(([k, v]) => `${quotePlus(String(k))}=${quotePlus(String(v))}`).join('&');
}

function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

const FORBIDDEN_GATEWAY_HEADER = 'x-line-application';

export class ChromeGateway {
  private readonly o: Required<Pick<GatewayOptions, 'baseUrl' | 'locale' | 'userAgent' | 'timeoutMs' | 'maxReadRetries' | 'retryDelayMs'>> &
    GatewayOptions;

  constructor(options: GatewayOptions) {
    this.o = {
      ...options,
      baseUrl: options.baseUrl ?? GATEWAY_BASE_URL,
      locale: options.locale ?? DEFAULT_LOCALE,
      userAgent: options.userAgent ?? CHROME_USER_AGENT,
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxReadRetries: options.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES,
      retryDelayMs: options.retryDelayMs ?? 0,
    };
  }

  /** Invoke a Thrift method by registry key. `args` are the positional Thrift arguments. */
  call<T = unknown>(endpointKey: ThriftEndpointKey, args: readonly unknown[], options: CallOptions): Promise<T> {
    return this.execute<T>(thriftPath(endpointKey), args, options, endpointKey, true);
  }

  /** POST a positional-args JSON array to an arbitrary gateway path (e.g. `/api/auth/tokenRefresh`, whose body is an object). */
  postJson<T = unknown>(path: string, body: unknown, options: CallOptions): Promise<T> {
    return this.execute<T>(path, body, options, undefined, true);
  }

  /**
   * Signed GET returning the raw Response (used for the SSE stream). No content-type, signs `path?query` with an empty
   * body (OkLine transport.py:457-500). Never retried here: the receiver owns reconnect policy. Non-2xx statuses are
   * returned, not thrown, so the receiver can classify them.
   */
  async get(path: string, params: QueryParams | undefined, options: GetOptions = {}): Promise<Response> {
    const requireAuth = options.requireAuth ?? true;
    const token = this.o.getAccessToken() ?? '';
    if (requireAuth && token === '') throw new ChromeLoginRequiredError('no access token; run a login flow first', path);
    const query = params === undefined ? '' : encodeQuery(params);
    const pathWithQuery = query === '' ? path : `${path}?${query}`;
    const headers =
      options.headerProfile === 'eventsource' ? this.eventSourceHeaders(requireAuth, token) : this.baseHeaders(path, requireAuth, token);
    // OkLine transport.py:473: no content-type on GET; X-Hmac signs `path?query` with an empty body.
    if (options.sign ?? true) headers.push(['X-Hmac', await this.o.signer.sign(token, pathWithQuery, '')]);
    this.appendExtraHeaders(headers, options.extraHeaders);
    const request: PhysicalRequest = {
      method: 'GET',
      url: this.o.baseUrl + pathWithQuery,
      path,
      pathWithQuery,
      headers,
      body: undefined,
      mode: 'read',
      endpointKey: undefined,
      attempt: 0,
      replay: false,
    };
    if (this.o.beforeRequest) await this.o.beforeRequest(request);
    const timeoutMs = options.timeoutMs ?? this.o.timeoutMs;
    const guard = new TimeoutGuard(timeoutMs, options.signal);
    try {
      // A redirect is an error: the signed request must not go to another host (F5).
      const response = await this.o.fetch(request.url, { method: 'GET', headers: toInitHeaders(headers), signal: guard.signal, redirect: 'error' });
      guard.clear(); // headers arrived; the stream body is not time-limited here
      return response;
    } catch (error) {
      guard.clear();
      throw guard.toTransportError(error, `GET ${path}`, false);
    }
  }

  // -- internals -------------------------------------------------------------------------------------------------

  /** OkLine operations.py:366-380 `_open_sse` header set. */
  private eventSourceHeaders(requireAuth: boolean, token: string): Array<[string, string]> {
    const h: Array<[string, string]> = [
      ['accept', 'text/event-stream'],
      ['cache-control', 'no-cache'],
      ['Accept-Language', this.o.locale],
      ['User-Agent', this.o.userAgent],
    ];
    if (requireAuth && token !== '') h.push(['X-Line-Access', token]);
    return h;
  }

  /** OkLine base_headers (transport.py:249-298) for the gateway. X-Line-Application is never added. */
  private baseHeaders(path: string, requireAuth: boolean, token: string): Array<[string, string]> {
    const h: Array<[string, string]> = [
      ['accept', 'application/json, text/plain, */*'],
      ['X-Line-Chrome-Version', CHROME_EXTENSION_VERSION],
      ['Accept-Language', this.o.locale],
      ['User-Agent', this.o.userAgent],
      ['X-LAL', lalForLocale(this.o.locale)],
    ];
    if (this.o.legyHost) h.push(['X-Legy-Host', this.o.legyHost]);
    if (requireAuth && token !== '') h.push(['X-Line-Access', token]);
    if (path.startsWith('/api/timeline/')) {
      const channel = this.o.getChannelToken?.();
      if (channel) h.push(['X-Line-ChannelToken', channel]);
    }
    return h;
  }

  /** Per-call extras go after X-Hmac. Same name replaces in place, like Python `dict.update`. */
  private appendExtraHeaders(headers: Array<[string, string]>, extra: Readonly<Record<string, string>> | undefined): void {
    if (!extra) return;
    for (const [name, value] of Object.entries(extra)) {
      if (name.toLowerCase() === FORBIDDEN_GATEWAY_HEADER) {
        throw new ChromeConfigError('X-Line-Application is only sent on private OBS fetches, never on gateway requests');
      }
      const existing = headers.findIndex(([n]) => n.toLowerCase() === name.toLowerCase());
      if (existing >= 0) headers[existing] = [headers[existing]![0], value];
      else headers.push([name, value]);
    }
  }

  private async execute<T>(
    path: string,
    args: unknown,
    options: CallOptions,
    endpointKey: ThriftEndpointKey | undefined,
    allowRefresh: boolean,
  ): Promise<T> {
    const requireAuth = options.requireAuth ?? true;
    const token = this.o.getAccessToken() ?? '';
    if (requireAuth && token === '') throw new ChromeLoginRequiredError('no access token; run a login flow first', path);

    // Compact JSON, equivalent to Python json.dumps(separators=(",", ":"), ensure_ascii=False) (transport.py:341).
    // `[]` for no arguments. X-Hmac signs exactly these bytes.
    const body = JSON.stringify(args ?? []);
    const headers = this.baseHeaders(path, requireAuth, token);
    headers.push(['content-type', 'application/json']); // only when there is a body (transport.py:339)
    // transport.py:346 signs with tokens.access_token even when requireAuth is false (it is "" during login).
    headers.push(['X-Hmac', await this.o.signer.sign(token, path, body)]);
    this.appendExtraHeaders(headers, options.extraHeaders);

    const mode = options.mode;
    const attempts = mode === 'read' ? 1 + Math.max(0, this.o.maxReadRetries) : 1;
    const timeoutMs = options.timeoutMs ?? this.o.timeoutMs;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const last = attempt === attempts - 1;
      const request: PhysicalRequest = {
        method: 'POST',
        url: this.o.baseUrl + path,
        path,
        pathWithQuery: path,
        headers,
        body,
        mode,
        endpointKey,
        attempt,
        replay: !allowRefresh,
      };
      if (this.o.beforeRequest) await this.o.beforeRequest(request);

      let status: number;
      let text: string;
      let contentType: string;
      const guard = new TimeoutGuard(timeoutMs, options.signal);
      try {
        const response = await this.o.fetch(request.url, {
          method: 'POST',
          headers: toInitHeaders(headers),
          body,
          signal: guard.signal,
          redirect: 'error', // a redirect is a transport error: the signed request must not go to another host
        });
        status = response.status;
        text = await response.text();
        contentType = response.headers.get('content-type') ?? '';
        guard.clear();
      } catch (error) {
        guard.clear();
        const wrapped = guard.toTransportError(error, `POST ${path}`, mode === 'write');
        if (mode === 'read' && !last && !guard.callerAborted) {
          await this.pause();
          continue;
        }
        throw wrapped;
      }

      // OkLine _send retries transient 5xx before decoding (transport.py:611-614). Reads only here.
      if (mode === 'read' && status >= 500 && !last) {
        await this.pause();
        continue;
      }

      const payload = decodePayload(text, contentType);
      if (status >= 200 && status < 300 && isOkEnvelope(payload)) {
        return ('data' in payload ? payload.data : payload) as T;
      }

      const error = classifyGatewayError({
        path,
        status,
        payload,
        ...(options.ignoreAuthException === undefined ? {} : { ignoreAuthException: options.ignoreAuthException }),
        ...(options.ignoreMustUpgrade === undefined ? {} : { ignoreMustUpgrade: options.ignoreMustUpgrade }),
      });

      if (error instanceof ChromeMustRefreshTokenError) {
        // Inner 119: renew the token and replay once, reads only (transport.py:381-410). A write is not replayed: the
        // first attempt could have reached LINE, and a replay could duplicate the mutation. For a write, the token is
        // still renewed (OkLine transport.py:507-544), so that the next request uses a valid token. Then the error is thrown.
        if (this.o.onMustRefresh && allowRefresh) {
          if (mode === 'read') {
            if (await this.safeRefresh()) return this.execute<T>(path, args, options, endpointKey, false);
          } else {
            await this.safeRefresh();
          }
        }
        throw error;
      }
      if (error instanceof ChromeRetryableApiError && mode === 'read' && !last) {
        await this.pause();
        continue;
      }
      throw error;
    }
    /* c8 ignore next */
    throw new ChromeTransportError(`request to ${path} failed: retries exhausted`, { outcomeUnknown: mode === 'write' });
  }

  private async safeRefresh(): Promise<boolean> {
    try {
      return (await this.o.onMustRefresh!()) === true;
    } catch {
      return false;
    }
  }

  private async pause(): Promise<void> {
    if (this.o.retryDelayMs <= 0) return;
    await (this.o.sleep ?? defaultSleep)(this.o.retryDelayMs);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toInitHeaders(headers: HeaderPairs): Array<[string, string]> {
  return headers.map(([n, v]) => [n, v]);
}

/** OkLine transport.py:735-742: the body is parsed only when the content-type names json or its first raw character can start JSON. */
const JSON_START = '[{"-0123456789tfn';
function decodePayload(text: string, contentType: string): unknown {
  if (text === '' || !(contentType.includes('json') || JSON_START.includes(text[0]!))) return undefined;
  try {
    return parsePreciseJson(text);
  } catch {
    return text;
  }
}

/** Success only on exactly `message === "OK"`, no case folding (transport.py:521-530). */
function isOkEnvelope(payload: unknown): payload is Record<string, unknown> & { message: 'OK' } {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && (payload as { message?: unknown }).message === 'OK';
}

/** Per-attempt timeout plus optional caller abort. */
class TimeoutGuard {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private readonly caller: AbortSignal | undefined;

  constructor(timeoutMs: number, caller: AbortSignal | undefined) {
    this.caller = caller;
    this.signal = caller ? AbortSignal.any([this.controller.signal, caller]) : this.controller.signal;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort(new Error('request timed out'));
      }, timeoutMs);
    }
  }

  get callerAborted(): boolean {
    return this.caller?.aborted === true;
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  toTransportError(error: unknown, what: string, write: boolean): ChromeTransportError {
    if (error instanceof ChromeTransportError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new ChromeTransportError(`${what} failed: ${this.timedOut ? 'timed out' : detail}`, {
      outcomeUnknown: write,
      timedOut: this.timedOut,
      cause: error,
    });
  }
}

