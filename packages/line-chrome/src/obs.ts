// Raw OBS (object storage) client for the CHROMEOS transport: private sealed-media download and upload.
// Ported from OkLine okline/obs.py: `build_talk_meta` :70-93, `_parse_encrypted_token` :96-104, `_obs_auth` :163-173,
// `upload_object` :212-235, `download_object` :237-268. The header order is OkLine's: `base_headers(with_access=False,
// base=obs_base)` (accept, X-Line-Chrome-Version, Accept-Language, User-Agent; no X-LAL, it is gateway-only), then the
// `_obs_auth` pair X-Line-Access (the ENCRYPTED access token, never the account token) + X-Line-Application, then the
// per-call extras. No content-type, no X-Hmac, no cookie.
//
// Nothing here touches the network on its own: every request is first handed to `authorize` (the mutation gate) and then
// sent through the injected, gate-guarded fetch.

import { CHROME_EXTENSION_VERSION, CHROME_USER_AGENT, DEFAULT_LOCALE, OBS_APPLICATION_HEADER, OBS_BASE_URL } from './constants.js';
import { ChromeError, ChromeTransportError } from './errors.js';
import type { FetchLike, HeaderPairs } from './gateway.js';

/** OkLine `EncryptedAccessTokenFeatureType.OBS_GENERAL`. */
export const OBS_GENERAL_FEATURE = 2;
/** Upper bound for one upload request; a 100 MiB file on a slow link must not be cut off by the 30 s RPC default. */
export const OBS_UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** The OBS request facts handed to the mutation gate (`ChromeObsRequest` there is structurally identical). */
export interface ObsRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: HeaderPairs;
  /** The exact bytes of an upload. The mutation gate binds its approval to them. Absent for a GET. */
  readonly body?: Uint8Array | undefined;
}

/** OBS answered with a non-success status. `status` 202 means "still encoding". */
export class ObsHttpError extends ChromeError {
  constructor(readonly status: number) {
    super(`OBS request failed: HTTP ${status}`);
  }
}

/** The response body is larger than the caller allows. Raised while streaming, so memory stays bounded. */
export class ObsSizeLimitError extends ChromeError {
  constructor(readonly maxBytes: number) {
    super(`OBS response exceeds ${maxBytes} bytes`);
  }
}

/** OkLine `encode_obs_params`: base64 of compact UTF-8 JSON. */
export function encodeObsParams(params: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
}

/**
 * OkLine `build_talk_meta` (obs.py:70-93, the bundle's `lB`): base64(json({"message": base64(thrift bytes)})) where the
 * thrift struct is a string field 4 (messageId) and an empty list-of-struct field 27. Required for `/r/talk/em*` reads.
 */
export function buildTalkMeta(messageId: string): string {
  const id = Buffer.from(messageId, 'utf8');
  const head = Buffer.alloc(7);
  head.writeUInt8(11, 0); // STRING
  head.writeInt16BE(4, 1); // field 4
  head.writeInt32BE(id.length, 3);
  const tail = Buffer.alloc(9);
  tail.writeUInt8(15, 0); // LIST
  tail.writeInt16BE(27, 1); // field 27
  tail.writeUInt8(12, 3); // element type STRUCT
  tail.writeInt32BE(0, 4); // empty
  tail.writeUInt8(0, 8); // STOP
  const blob = Buffer.concat([head, id, tail]).toString('base64');
  return Buffer.from(JSON.stringify({ message: blob }), 'utf8').toString('base64');
}

/**
 * This function equals OkLine `_parse_encrypted_token`: records split on RS (0x1e), fields on US (0x1f); the token is
 * `rows[1][0]`. The fetch layer rejects a value that is not a legal header value.
 */
export function parseEncryptedAccessToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const rows = raw.split('\x1e').filter((row) => row !== '').map((row) => row.split('\x1f'));
  const token = rows.length > 1 ? rows[1]?.[0] : undefined;
  if (token === undefined || token.length === 0) return null;
  return token;
}

export interface ObsClientOptions {
  /** The gate-guarded fetch (Node undici in production). */
  fetch: FetchLike;
  /** Returns the encrypted OBS_GENERAL access token for ONE operation (`acquireEncryptedAccessToken [2]`). */
  acquireToken: (signal?: AbortSignal) => Promise<string>;
  /** Approves each request with the mutation gate before it is sent; throw to block. */
  authorize: (request: ObsRequest) => void | Promise<void>;
  baseUrl?: string;
  locale?: string;
  userAgent?: string;
  uploadTimeoutMs?: number;
}

export interface ObsDownloadOptions {
  /** OBS namespace under `/r/talk/`: `emi|emv|ema|emf` for sealed media, `m` for plain message media. */
  sid: string;
  oid: string;
  /** Appended to the path, e.g. `/original`. */
  suffix?: string;
  /** Sealed media (`em*`) needs the `X-Talk-Meta` header built from the message id. */
  talkMessageId?: string | null;
  /** `OBS_POP` as the single `p` query parameter. */
  pop?: string | null;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ObsUploadOptions {
  /** Full OBS path below `/r/`, e.g. `talk/emi/reqid-<uuid>`. */
  path: string;
  data: Uint8Array;
  params: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface ObsUploadResult {
  objId: string;
  objHash: string;
}

export class ObsClient {
  private token: Promise<string> | undefined;
  private readonly o: Required<Pick<ObsClientOptions, 'baseUrl' | 'locale' | 'userAgent' | 'uploadTimeoutMs'>> & ObsClientOptions;

  constructor(options: ObsClientOptions) {
    this.o = {
      ...options,
      baseUrl: options.baseUrl ?? OBS_BASE_URL,
      locale: options.locale ?? DEFAULT_LOCALE,
      userAgent: options.userAgent ?? CHROME_USER_AGENT,
      uploadTimeoutMs: options.uploadTimeoutMs ?? OBS_UPLOAD_TIMEOUT_MS,
    };
  }

  /** OkLine `_obs_auth` + `base_headers(with_access=False, base=obs_base)`, in OkLine's order. */
  private async headers(signal: AbortSignal | undefined): Promise<Array<[string, string]>> {
    // One token per client instance, i.e. per logical operation: an image upload (original + preview) asks for it once.
    if (this.token === undefined) {
      const pending = this.o.acquireToken(signal);
      this.token = pending;
      pending.catch(() => { if (this.token === pending) this.token = undefined; });
    }
    const token = await this.token;
    return [
      ['accept', 'application/json, text/plain, */*'],
      ['X-Line-Chrome-Version', CHROME_EXTENSION_VERSION],
      ['Accept-Language', this.o.locale],
      ['User-Agent', this.o.userAgent],
      ['X-Line-Access', token],
      ['X-Line-Application', OBS_APPLICATION_HEADER],
    ];
  }

  /** OkLine `download_object` (the extension's `zD`): one GET, bounded while streaming. Non-200 raises `ObsHttpError`. */
  async download(options: ObsDownloadOptions): Promise<Buffer> {
    throwIfAborted(options.signal);
    const headers = await this.headers(options.signal);
    if (options.talkMessageId) headers.push(['X-Talk-Meta', buildTalkMeta(options.talkMessageId)]);
    const url = new URL(`${this.o.baseUrl}/r/talk/${options.sid}/${options.oid}${options.suffix ?? ''}`);
    if (options.pop) url.searchParams.set('p', options.pop);
    const request: ObsRequest = { method: 'GET', url: url.toString(), headers };
    await this.o.authorize(request);
    throwIfAborted(options.signal);
    let response: Response;
    try {
      response = await this.o.fetch(request.url, {
        method: 'GET', headers: headers.map(([n, v]) => [n, v]), redirect: 'error', ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new ChromeTransportError(`OBS GET failed: ${error instanceof Error ? error.message : String(error)}`, { outcomeUnknown: false, cause: error });
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new ObsHttpError(response.status);
    }
    return readBounded(response, options.maxBytes, options.signal);
  }

  /** OkLine `upload_object` (the extension's `qD`): one POST of the raw bytes with `X-Obs-Params`. */
  async upload(options: ObsUploadOptions): Promise<ObsUploadResult> {
    throwIfAborted(options.signal);
    const headers = await this.headers(options.signal);
    headers.push(['X-Obs-Params', encodeObsParams(options.params)]);
    const url = `${this.o.baseUrl}/r/${options.path}`;
    const request: ObsRequest = { method: 'POST', url, headers, body: options.data };
    await this.o.authorize(request);
    const timeout = AbortSignal.timeout(this.o.uploadTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.o.fetch(url, {
        method: 'POST', headers: headers.map(([n, v]) => [n, v]), redirect: 'error', signal,
        body: options.data as unknown as NonNullable<RequestInit['body']>,
      });
    } catch (error) {
      throw new ChromeTransportError(`OBS POST failed: ${error instanceof Error ? error.message : String(error)}`, {
        outcomeUnknown: false, timedOut: timeout.aborted, cause: error,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new ObsHttpError(response.status);
    }
    // The object id comes from the `x-obs-oid` header only (line-cli client.go:698-703). The body is never read.
    const objId = response.headers.get('x-obs-oid') ?? '';
    const objHash = response.headers.get('x-obs-hash') ?? '';
    await response.body?.cancel().catch(() => undefined);
    return { objId, objHash };
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
}

/** Streams the body, failing as soon as it exceeds `maxBytes` (also checks Content-Length up front) or `signal` aborts. */
export async function readBounded(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ObsSizeLimitError(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  aborted.catch(() => undefined);
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => undefined); rejectAbort(signal?.reason ?? new Error('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) { throwIfAborted(signal); break; } // a cancel from the abort handler also reads as "done"
      total += item.value.byteLength;
      if (total > maxBytes) throw new ObsSizeLimitError(maxBytes);
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* stream already cancelled */ }
  }
}
