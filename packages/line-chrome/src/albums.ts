// Album support of the CHROMEOS transport, ported from line-cli (the only reference with album code):
//  - `AcquireChannelAccessToken` (pkg/line/methods.go:769-816, `parseChannelTokenExpiration` :819-): `ChannelService.issueChannelToken
//    ["1341209850"]` on the gateway, cached per channel until shortly before it expires.
//  - `DownloadAlbumPreview` (pkg/line/client.go:833-): `GET https://obs.line-apps.com/r/album/a/<oid>/f482x482` with
//    `X-Line-ChannelToken`, `X-Line-Mid` (the chat), `X-Line-Album` (when known) and `X-Line-Access`; no X-Line-Application.
//    The test `TestDownloadAlbumPreviewMatchesLINERequestContract` (pkg/line/obs_test.go:429-) pins that header contract.
// line-cli has no album list and no photo list call, so none exists here. The channel token also matches OkLine's
// `_channel_token` (okline/obs.py:136-153), which uses the same channel id for the timeline/myhome channel.
//
// Nothing here touches the network on its own: every request is first handed to `authorize` (the mutation gate).

import { CHROME_USER_AGENT, OBS_BASE_URL } from './constants.js';
import { ChromeTransportError } from './errors.js';
import type { FetchLike, HeaderPairs } from './gateway.js';
import { ObsHttpError, readBounded, throwIfAborted, type ObsRequest } from './obs.js';

/** line-cli `albumPreviewChannelID`: LINE's Chrome home (timeline) channel. */
export const ALBUM_CHANNEL_ID = '1341209850';
/** line-cli `albumPreviewTID`: the 482 px thumbnail rendition. */
export const ALBUM_PREVIEW_TID = 'f482x482';
/** line-cli `obsTokenBuffer` / `defaultChannelTokenLifetime`. */
const CHANNEL_TOKEN_BUFFER_MS = 30_000;
const CHANNEL_TOKEN_DEFAULT_LIFETIME_MS = 5 * 60_000;

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** line-cli `parseChannelTokenExpiration`: epoch ms, epoch s, relative seconds or an RFC 3339 string. Returns epoch ms. */
export function parseChannelTokenExpiration(raw: unknown, nowMs: number): number {
  const fallback = nowMs + CHANNEL_TOKEN_DEFAULT_LIFETIME_MS;
  let numeric: number | undefined;
  // A JSON number must be an integer. A fraction gives the fallback (line-cli methods.go:779).
  if (typeof raw === 'number') numeric = Number.isInteger(raw) ? raw : undefined;
  else if (typeof raw === 'string') {
    // An RFC 3339 string is tested first. A string that does not match is numeric or gives the fallback (methods.go:819-855).
    if (RFC3339.test(raw)) {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed - CHANNEL_TOKEN_BUFFER_MS;
    } else if (/^-?\d+$/.test(raw)) numeric = Number(raw);
  }
  if (numeric === undefined) return fallback;
  let expiresAt: number;
  if (numeric > 100_000_000_000) expiresAt = numeric;
  else if (numeric > 1_000_000_000) expiresAt = numeric * 1000;
  else if (numeric > 0) expiresAt = nowMs + numeric * 1000;
  else return fallback;
  if (expiresAt < nowMs + CHANNEL_TOKEN_BUFFER_MS) return fallback;
  return expiresAt - CHANNEL_TOKEN_BUFFER_MS;
}

/** Calls `issueChannelToken [channelId]` through the gate-guarded gateway and returns the raw `data` struct. */
export type IssueChannelToken = (channelId: string, signal?: AbortSignal) => Promise<unknown>;

/** The channel could not issue a usable token. Carries no token material. */
export class ChannelTokenError extends Error {
  constructor() { super('issueChannelToken returned no channelAccessToken'); this.name = 'ChannelTokenError'; }
}

/** line-cli `channelTokenCache`: one token per channel id, reused until its (buffered) expiry. In-flight issues are shared. */
export class ChannelTokenCache {
  readonly #issue: IssueChannelToken;
  readonly #now: () => number;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #pending = new Map<string, Promise<string>>();

  constructor(issue: IssueChannelToken, now: () => number = Date.now) {
    this.#issue = issue;
    this.#now = now;
  }

  async get(channelId: string, signal?: AbortSignal): Promise<string> {
    if (channelId === '') throw new RangeError('channel ID is required');
    const cached = this.#tokens.get(channelId);
    if (cached !== undefined && cached.token !== '' && this.#now() < cached.expiresAt) return cached.token;
    const existing = this.#pending.get(channelId);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      // Read the clock before the RPC, as line-cli does, so the lifetime counts from the request start.
      const now = this.#now();
      const data = await this.#issue(channelId, signal);
      // OkLine okline/obs.py:150-152 reads `channelAccessToken` (falling back to `token`); line-cli reads only the former.
      const record = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
      const token = typeof record.channelAccessToken === 'string' ? record.channelAccessToken : undefined;
      if (token === undefined || token === '') throw new ChannelTokenError();
      this.#tokens.set(channelId, { token, expiresAt: parseChannelTokenExpiration(record.expiration, now) });
      return token;
    })().finally(() => { this.#pending.delete(channelId); });
    this.#pending.set(channelId, pending);
    return pending;
  }

  /** Forget every token: after a failed read (it may have been stale), a login change or a revoke. */
  clear(): void { this.#tokens.clear(); }
}

export interface AlbumPreviewOptions {
  fetch: FetchLike;
  /** Approves the request with the mutation gate before it is sent; throw to block. */
  authorize: (request: ObsRequest) => void | Promise<void>;
  /** The album channel token (`ChannelTokenCache.get(ALBUM_CHANNEL_ID)`). */
  channelToken: string;
  /** The ACCOUNT access token (line-cli sends it as `X-Line-Access`, not the encrypted OBS token). */
  accessToken: string;
  /** The chat the album belongs to (`X-Line-Mid`). */
  chatId: string;
  /** The album id (`X-Line-Album`); omitted when empty, as in line-cli. */
  albumId?: string;
  oid: string;
  maxBytes: number;
  signal?: AbortSignal;
  baseUrl?: string;
  locale?: string;
  userAgent?: string;
}

/** The request line-cli sends (`DownloadAlbumPreview`, client.go:855-863): exactly these headers, in this order. */
export function buildAlbumPreviewRequest(options: Omit<AlbumPreviewOptions, 'fetch' | 'authorize' | 'maxBytes' | 'signal'>): ObsRequest {
  if (options.oid === '' || options.chatId === '') throw new RangeError('album preview OID and chat ID are required');
  const headers: Array<[string, string]> = [
    ['User-Agent', options.userAgent ?? CHROME_USER_AGENT],
    ['X-Line-ChannelToken', options.channelToken],
    ['X-Line-Mid', options.chatId],
  ];
  if (options.albumId !== undefined && options.albumId !== '') headers.push(['X-Line-Album', options.albumId]);
  if (options.accessToken !== '') headers.push(['X-Line-Access', options.accessToken]);
  const url = `${options.baseUrl ?? OBS_BASE_URL}/r/album/a/${encodeURIComponent(options.oid)}/${ALBUM_PREVIEW_TID}`;
  return { method: 'GET', url, headers: headers as HeaderPairs };
}

/**
 * line-cli `DownloadAlbumPreview`: one GET, no retry (a 202 "still encoding" or 404 is reported as `ObsHttpError`, as
 * line-cli reports ErrOBSEncodingIncomplete / ErrOBSObjectNotFound), bounded while streaming, redirects refused.
 */
export async function downloadAlbumPreview(options: AlbumPreviewOptions): Promise<Buffer> {
  throwIfAborted(options.signal);
  const request = buildAlbumPreviewRequest(options);
  await options.authorize(request);
  throwIfAborted(options.signal);
  let response: Response;
  try {
    response = await options.fetch(request.url, {
      method: 'GET', headers: request.headers.map(([n, v]) => [n, v]), redirect: 'error', ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new ChromeTransportError(`OBS album GET failed: ${error instanceof Error ? error.message : String(error)}`, { outcomeUnknown: false, cause: error });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ObsHttpError(response.status);
  }
  return readBounded(response, options.maxBytes, options.signal);
}
