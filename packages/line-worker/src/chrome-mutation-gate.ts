import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ALBUM_CHANNEL_ID, ALBUM_PREVIEW_TID, CHROME_EXTENSION_VERSION, GATEWAY_BASE_URL, OBS_APPLICATION_HEADER, OBS_BASE_URL, USED_ENDPOINTS, specialPath, thriftPath,
  type EndpointAccess, type EndpointUsage, type PhysicalRequest, type ThriftEndpointKey } from "@line-agent/line-chrome";
import { assertIdentity, copyLease, deny, EffectDeniedError, type ControlLease, type ControlLeasePhase, type EffectPhase, type MediaUploadKind, type MediaUploadScope } from "./mutation-gate.js";

type MediaUploadState = { closed: boolean; posts: number; readonly paths: Set<string>; manual: boolean };
const IDENTIFIER_WITH_DIGIT = "(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const OBS_UPLOAD_PATH = /^\/r\/talk\/(emi|emf)\/reqid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBS_UPLOAD_PREVIEW_PATH = new RegExp(`^/r/talk/emi/${IDENTIFIER_WITH_DIGIT}__ud-preview$`);

// CHROMEOS mutation gate. This module is loaded only when the CHROMEOS adapter is selected.
const CHROME_GATEWAY_ORIGIN = new URL(GATEWAY_BASE_URL).origin;
const CHROME_OBS_ORIGIN = new URL(OBS_BASE_URL).origin;
const CHROME_SSE_PATH = specialPath("operation.receive");
const CHROME_TOKEN_REFRESH_PATH = specialPath("auth.tokenRefresh");
const CHROME_SSE_QUERY = ["version", "language", "lastPartialFullSyncs", "localRev"] as const;
const CHROME_TICKET_TTL_MS = 60_000;
/** CHROMEOS private download paths. Only these two shapes exist in the extension's OBS reads (OkLine obs.py download_object). */
const CHROME_OBS_MESSAGE_PATH = new RegExp(`^/r/talk/m/${IDENTIFIER_WITH_DIGIT}(?:/original)?$`);
const CHROME_OBS_E2EE_PATH = new RegExp(`^/r/talk/(?:emi|emv|ema|emf)/${IDENTIFIER_WITH_DIGIT}$`);
/** line-cli `DownloadAlbumPreview` path: `/r/album/a/<oid>/f482x482` (pkg/line/client.go:833-). Nothing else under `/r/album/` is allowed. */
const CHROME_ALBUM_PREVIEW_PATH = new RegExp(`^/r/album/a/[A-Za-z0-9._~%-]{1,256}/${ALBUM_PREVIEW_TID}$`);
const CHROME_ALBUM_TOKEN_BODY = JSON.stringify([ALBUM_CHANNEL_ID]);
const CHROME_CHANNEL_TOKEN_KEY: ThriftEndpointKey = "Talk.ChannelService.issueChannelToken";
const CHROME_SSE_REV = /^(?:0|[1-9][0-9]{0,18})$/;

type ChromeEndpointInfo = Readonly<{ key: ThriftEndpointKey; access: EndpointAccess; area: EndpointUsage["area"] }>;
/** `/api/talk/thrift/<NS>/<Service>/<method>` to its registry entry, derived from `USED_ENDPOINTS` only. */
const CHROME_ENDPOINT_BY_PATH: ReadonlyMap<string, ChromeEndpointInfo> = new Map(
  (Object.entries(USED_ENDPOINTS) as [ThriftEndpointKey, EndpointUsage][]).map(([key, usage]) =>
    [thriftPath(key), { key, access: usage.access, area: usage.area }] as const),
);
const CHROME_LOGOUT_KEY: ThriftEndpointKey = "Talk.AuthService.logoutV2";
const CHROME_IDENTITY_KEY: ThriftEndpointKey = "Talk.TalkService.getProfile";
/** Manual sends may only send or unsend (plus the group-key registration a group send needs). */
const CHROME_MANUAL_WRITE_KEYS = new Set<ThriftEndpointKey>(["Talk.TalkService.sendMessage", "Talk.TalkService.unsendMessage"]);

export type ChromeEffectContext = Readonly<{ phase: EffectPhase; lease?: ControlLease; signal?: AbortSignal;
  /** SERVER_LOGOUT only: the existing access token the logout request must carry. */
  serverLogoutToken?: string }>;
export type ChromeMutationGateOptions = Readonly<{
  accountId: string;
  workerInstanceId: string;
  controlEpoch?: number;
  validateControlLease: (lease: ControlLease, phase: ControlLeasePhase) => boolean | Promise<boolean>;
  now?: () => number;
}>;
type ChromeHeaders = ReadonlyArray<readonly [string, string]>;
/** The OBS request facts the gate needs (step 6 builds these from the real request). */
export type ChromeObsRequest = Readonly<{ method: "GET" | "POST"; url: string; headers: ChromeHeaders; body?: Uint8Array | undefined }>;
type ChromePermit = {
  active: boolean;
  readonly phase: EffectPhase;
  readonly lease?: ControlLease;
  readonly signal?: AbortSignal;
  readonly serverLogoutToken?: string;
  /** The one non-key-registration write (send, unsend, react, add friend, logout) this permit may authorise. */
  writeConsumed: boolean;
  /** The one E2EE group-key registration a send may need. */
  keyRegistrationConsumed: boolean;
  /** True for a permit that `beforeRequestFor` opens for one request. The permit ends when its ticket is consumed. */
  readonly standing: boolean;
};

function chromeHeader(headers: ChromeHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([headerName]) => headerName.toLowerCase() === lower)?.[1];
}
function isChromeWritePhase(phase: EffectPhase): boolean { return phase === "CONTROL_SEND" || phase === "MANUAL_SEND"; }

/** True when the endpoint may run in the phase. Mirrors the DESKTOPWIN sets: reads, sends, bootstrap, logout. */
function chromeEndpointAllowed(info: ChromeEndpointInfo, phase: EffectPhase): boolean {
  switch (phase) {
    case "AUTH_BOOTSTRAP": return info.access === "auth" || info.key === CHROME_IDENTITY_KEY;
    case "MONITOR_READ": return info.access === "read" && info.area !== "contacts";
    case "CONTROL_READ": return info.access === "read";
    // A send flow also needs the key and media-flow lookups of its own sealing step.
    case "CONTROL_SEND":
      return (info.access === "read" && (info.area === "e2ee" || info.area === "media"))
        || (info.access === "write" && info.area !== "session");
    case "MANUAL_SEND":
      return (info.access === "read" && (info.area === "e2ee" || info.area === "media"))
        || CHROME_MANUAL_WRITE_KEYS.has(info.key) || (info.access === "write" && info.area === "e2ee");
    case "SERVER_LOGOUT": return info.key === CHROME_LOGOUT_KEY;
    default: return false; // CHAT_RESOURCE_BOOTSTRAP is a DESKTOPWIN (channel token) concept
  }
}
/** `read` endpoints must never be sent as writes (that would drop the retry rules) and writes never as reads. */
function chromeModeMatches(info: ChromeEndpointInfo, mode: string): boolean {
  return info.access === "read" ? mode === "read" : mode === "write"; // `auth` calls are non-retrying, like writes
}

export class ChromeMutationGate {
  readonly #accountId: string;
  readonly #workerInstanceId: string;
  readonly #controlEpoch: number | undefined;
  readonly #validateControlLease: ChromeMutationGateOptions["validateControlLease"];
  readonly #now: () => number;
  readonly #context = new AsyncLocalStorage<ChromePermit>();
  readonly #tickets = new Map<string, ChromeTicket[]>();
  readonly #mediaScopes = new WeakMap<MediaUploadScope, MediaUploadState>();

  constructor(options: ChromeMutationGateOptions) {
    assertIdentity(options.accountId, "accountId");
    assertIdentity(options.workerInstanceId, "workerInstanceId");
    if (typeof options.validateControlLease !== "function") deny("a control lease validator is required");
    this.#accountId = options.accountId;
    this.#workerInstanceId = options.workerInstanceId;
    this.#controlEpoch = options.controlEpoch;
    this.#validateControlLease = options.validateControlLease;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Opens one permit for one logical operation and runs `fn` inside it. Requests whose gateway uses `beforeRequest()` are
   * authorised against this permit. A send phase carries at most one write (plus one group-key registration): open one
   * `run` per logical write, including the single renegotiation retry.
   */
  async run<T>(context: ChromeEffectContext, fn: () => Promise<T>): Promise<T> {
    const permit = this.#openPermit(context);
    try { return await this.#context.run(permit, fn); }
    finally { permit.active = false; this.#dropTickets(permit); }
  }

  /** `GatewayOptions.beforeRequest` for the main gateway: authorises against the permit of the surrounding `run`. */
  beforeRequest(): (request: PhysicalRequest) => Promise<void> {
    return async (request) => {
      const permit = this.#context.getStore();
      if (permit === undefined || !permit.active) return deny("gateway request has no active effect context");
      await this.#approve(permit, request);
    };
  }

  /**
   * `beforeRequest` for a gateway that works outside any `run` (the token refresher's timers, the SSE receiver). The
   * context is evaluated on every request. Only non-write phases can be used this way.
   */
  beforeRequestFor(source: () => ChromeEffectContext): (request: PhysicalRequest) => Promise<void> {
    return async (request) => {
      const context = source();
      if (isChromeWritePhase(context.phase) || context.phase === "SERVER_LOGOUT") {
        return deny("a standing gateway hook cannot authorise writes");
      }
      await this.#approve(this.#openPermit(context, true), request);
    };
  }

  /**
   * Wraps the injected fetch: a request is forwarded only if a hook approved the same method, URL and body, once. This is
   * what makes "nothing reaches the network without a permit" hold even if a caller forgets the hook.
   */
  guardFetch<F extends (input: string, init: RequestInit) => Promise<Response>>(inner: F): F {
    const guarded = (async (input: string, init: RequestInit) => {
      // A redirect would send the approved headers to a URL that no hook approved.
      if (init?.redirect !== "error") return deny("physical request must block redirects");
      // The key covers method, URL, the ordered header pairs and the body, so the request that goes out is the one that was approved.
      const key = ticketKey(init?.method ?? "GET", String(input), init?.headers, init?.body);
      const live = (this.#tickets.get(key) ?? []).filter((ticket) => ticket.expiresAt > this.#now() && ticket.alive());
      if (live.length === 0) { this.#tickets.delete(key); return deny("physical request was not approved by the mutation gate"); }
      const taken = live.shift();
      // A standing permit serves one request only: its approval ends when the ticket is consumed.
      if (taken !== undefined && (taken.owner as Partial<ChromePermit>).standing === true) (taken.owner as ChromePermit).active = false;
      if (live.length === 0) this.#tickets.delete(key); else this.#tickets.set(key, live);
      return inner(input, init);
    }) as F;
    return guarded;
  }

  // -- OBS (declared for step 6; nothing in the CHROMEOS adapter calls these yet, so OBS stays unreachable) -------------

  /** Approves one OBS download or preflight GET. Read phases only; the private-fetch headers are mandatory. */
  async approveObsDownload(effect: Readonly<{ phase: "MONITOR_READ" | "CONTROL_READ"; lease?: ControlLease }>,
    request: ChromeObsRequest): Promise<void> {
    if (effect.phase !== "MONITOR_READ" && effect.phase !== "CONTROL_READ") return deny("OBS download is not allowed in this phase");
    if (request.method !== "GET") return deny("OBS download must be a GET");
    const url = this.#obsUrl(request);
    if (!CHROME_OBS_MESSAGE_PATH.test(url.pathname) && !CHROME_OBS_E2EE_PATH.test(url.pathname)) {
      return deny("OBS download path is not allowlisted");
    }
    if (url.search !== "") {
      const pop = url.searchParams.getAll("p");
      if (!/^\?p=[A-Za-z0-9._~+%-]{1,768}$/.test(url.search) || pop.length !== 1 || url.searchParams.size !== 1 ||
        pop[0]!.length === 0 || pop[0]!.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(pop[0]!)) {
        return deny("OBS query is not one bounded POP value");
      }
    }
    this.#assertObsHeaders(request.headers);
    if (effect.phase === "CONTROL_READ") await this.#assertCurrentLease(this.#bindLease(effect.lease, effect.phase), "CONTROL_READ");
    const permit = this.#context.getStore();
    if (permit === undefined || !permit.active) return deny("download approval requires an active permit");
    this.#issueTicket(permit, () => permit.active, request.method, request.url, request.headers, undefined);
  }

  /**
   * Approves one album photo GET (line-cli `DownloadAlbumPreview`). Read phases only. Unlike private message media it carries
   * the channel token, the chat MID and the account token, and never X-Line-Application.
   */
  async approveAlbumPhotoDownload(effect: Readonly<{ phase: "MONITOR_READ" | "CONTROL_READ"; lease?: ControlLease }>,
    request: ChromeObsRequest): Promise<void> {
    if (effect.phase !== "MONITOR_READ" && effect.phase !== "CONTROL_READ") return deny("album download is not allowed in this phase");
    if (request.method !== "GET") return deny("album download must be a GET");
    const url = this.#obsUrl(request);
    if (!CHROME_ALBUM_PREVIEW_PATH.test(url.pathname) || url.search !== "") return deny("album download path is not allowlisted");
    for (const name of ["x-line-channeltoken", "x-line-mid", "x-line-access"]) {
      const value = chromeHeader(request.headers, name);
      if (value === undefined || value === "") return deny(`album download carries ${name}`);
    }
    if (chromeHeader(request.headers, "x-line-application") !== undefined) return deny("album download never carries X-Line-Application");
    for (const name of ["accept-language", "x-line-chrome-version"]) {
      if (chromeHeader(request.headers, name) !== undefined) return deny(`album download never carries ${name}`);
    }
    if (chromeHeader(request.headers, "cookie") !== undefined) return deny("album download never carries a cookie");
    if (effect.phase === "CONTROL_READ") await this.#assertCurrentLease(this.#bindLease(effect.lease, effect.phase), "CONTROL_READ");
    const permit = this.#context.getStore();
    if (permit === undefined || !permit.active) return deny("download approval requires an active permit");
    this.#issueTicket(permit, () => permit.active, request.method, request.url, request.headers, undefined);
  }

  /** Opens the only context in which OBS upload POSTs may be approved. The caller closes it in `finally`. */
  openMediaUploadScope(lease: ControlLease, kind: MediaUploadKind, manual = false): MediaUploadScope {
    const phase = manual ? "MANUAL_SEND" : "CONTROL_SEND";
    const bound = this.#bindLease(lease, phase);
    if (kind !== "image" && kind !== "file") return deny("unknown media kind");
    const state: MediaUploadState = { closed: false, posts: 0, paths: new Set(), manual };
    // Closing the scope also deletes the tickets it issued: a request approved for it cannot go out after the scope ends.
    const scope: MediaUploadScope = Object.freeze({ kind, lease: bound, manual, close: () => { state.closed = true; this.#dropTickets(state); } });
    this.#mediaScopes.set(scope, state);
    return scope;
  }

  /** Approves one OBS upload POST inside an open scope: exactly one POST per scope, for both kinds, no query, no preview upload. */
  async approveMediaUpload(scope: MediaUploadScope, request: ChromeObsRequest): Promise<void> {
    const state = this.#mediaScopes.get(scope);
    if (state === undefined || state.closed) return deny("media upload has no open scope");
    if (request.method !== "POST") return deny("media upload must be a POST");
    const url = this.#obsUrl(request);
    if (url.search !== "") return deny("media upload must not carry a query");
    const match = OBS_UPLOAD_PATH.exec(url.pathname);
    if (match === null || match[1] !== (scope.kind === "image" ? "emi" : "emf")) return deny("media upload path is not allowlisted");
    if (state.posts >= 1 || state.paths.has(url.pathname)) return deny("media upload scope limit reached");
    this.#assertObsHeaders(request.headers);
    // Reserve synchronously so concurrent reuse of the same path cannot pass the async lease check.
    state.posts += 1;
    state.paths.add(url.pathname);
    await this.#assertCurrentLease(scope.lease, state.manual ? "MANUAL_SEND" : "CONTROL_SEND");
    if (state.closed) return deny("media upload scope closed");
    this.#issueTicket(state, () => !state.closed, request.method, request.url, request.headers, request.body);
  }

  // -- internals ---------------------------------------------------------------------------------------------------------

  #openPermit(context: ChromeEffectContext, standing = false): ChromePermit {
    const phase = context.phase;
    if (phase === "CHAT_RESOURCE_BOOTSTRAP") return deny("chat resource bootstrap is not part of the CHROMEOS profile");
    let lease: ControlLease | undefined;
    if (phase === "CONTROL_READ" || phase === "CONTROL_SEND" || phase === "MANUAL_SEND") lease = this.#bindLease(context.lease, phase);
    else if (context.lease !== undefined) return deny(`${phase} does not take a control lease`);
    if (phase === "SERVER_LOGOUT") assertIdentity(context.serverLogoutToken, "serverLogoutToken");
    else if (context.serverLogoutToken !== undefined) return deny("only SERVER_LOGOUT carries a logout token");
    return { active: true, phase, writeConsumed: false, keyRegistrationConsumed: false, standing,
      ...(lease === undefined ? {} : { lease }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.serverLogoutToken === undefined ? {} : { serverLogoutToken: context.serverLogoutToken }) };
  }

  async #approve(permit: ChromePermit, request: PhysicalRequest): Promise<void> {
    const classified = this.#classify(permit, request);
    if (permit.signal?.aborted) return deny("effect context was cancelled");
    const write = classified.consumes;
    if (write === "primary" && permit.writeConsumed) return deny(`${permit.phase} permit is single-use; retry is unknown`);
    if (write === "key" && permit.keyRegistrationConsumed) return deny(`${permit.phase} group-key permit is single-use`);
    if (permit.lease !== undefined) await this.#assertCurrentLease(permit.lease, permit.phase as ControlLeasePhase);
    // A single-use permit can be exercised concurrently: recheck after the async lease validator, consume synchronously.
    if (write === "primary") {
      if (permit.writeConsumed) return deny(`${permit.phase} permit is single-use; retry is unknown`);
      permit.writeConsumed = true;
    } else if (write === "key") {
      if (permit.keyRegistrationConsumed) return deny(`${permit.phase} group-key permit is single-use`);
      permit.keyRegistrationConsumed = true;
    }
    if (!permit.active) return deny("effect context is closed");
    this.#issueTicket(permit, () => permit.active, request.method, request.url, request.headers, request.body);
  }

  /** Stateless checks: host, path, mode, headers and phase. Returns which single-use slot a write takes. */
  #classify(permit: ChromePermit, request: PhysicalRequest): Readonly<{ consumes: "none" | "primary" | "key" }> {
    if (typeof request?.url !== "string" || typeof request.path !== "string") return deny("malformed physical request");
    const url = new URL(request.url);
    if (url.origin !== CHROME_GATEWAY_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "" ||
      url.pathname !== request.path || `${url.pathname}${url.search}` !== request.pathWithQuery) {
      return deny("request host/path is not the pinned Chrome gateway");
    }
    if (chromeHeader(request.headers, "x-line-application") !== undefined) return deny("gateway requests never carry X-Line-Application");
    if (chromeHeader(request.headers, "cookie") !== undefined) return deny("gateway requests never carry a cookie");
    if (request.method === "GET") return this.#classifyStream(permit, request, url);
    if (request.method !== "POST" || typeof request.body !== "string" || url.search !== "") {
      return deny("gateway POST must carry a JSON body and no query string");
    }
    if (request.path === CHROME_TOKEN_REFRESH_PATH) {
      if (permit.phase !== "AUTH_BOOTSTRAP") return deny(`token refresh is not allowlisted for ${permit.phase}`);
      if (request.mode !== "write") return deny("token refresh must be a non-retrying call");
      let body: unknown;
      try { body = JSON.parse(request.body); } catch { return deny("token refresh body is not JSON"); }
      const keys = body !== null && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
      if (keys.length !== 1 || keys[0] !== "refreshToken" || typeof (body as { refreshToken?: unknown }).refreshToken !== "string") {
        return deny("token refresh body is not exactly the refresh token");
      }
      return { consumes: "none" };
    }
    const info = CHROME_ENDPOINT_BY_PATH.get(request.path);
    if (info === undefined) return deny("gateway path is not in the endpoint registry");
    if (request.endpointKey !== undefined && request.endpointKey !== info.key) return deny("endpoint key does not match the request path");
    if (!chromeEndpointAllowed(info, permit.phase)) return deny(`RPC is not allowlisted for ${permit.phase}`);
    // The only channel token the transport may ask for is the album (home) channel's, with exactly that body.
    if (info.key === CHROME_CHANNEL_TOKEN_KEY && request.body !== CHROME_ALBUM_TOKEN_BODY) return deny("channel token request is not the album channel");
    if (!chromeModeMatches(info, request.mode)) return deny("call mode does not match the endpoint access");
    if (permit.phase === "SERVER_LOGOUT") {
      if (chromeHeader(request.headers, "x-line-access") !== permit.serverLogoutToken) {
        return deny("server logout token does not match the existing token");
      }
    }
    if (info.access === "write") return { consumes: info.area === "e2ee" ? "key" : "primary" };
    return { consumes: "none" };
  }

  /** The SSE stream: a read-only GET of exactly the operation endpoint with the fixed query shape. */
  #classifyStream(permit: ChromePermit, request: PhysicalRequest, url: URL): Readonly<{ consumes: "none" }> {
    if (permit.phase !== "MONITOR_READ" && permit.phase !== "CONTROL_READ") return deny(`event stream is not allowlisted for ${permit.phase}`);
    if (request.path !== CHROME_SSE_PATH || request.body !== undefined || request.mode !== "read") return deny("GET is restricted to the event stream");
    const keys = [...url.searchParams.keys()];
    if (keys.length !== CHROME_SSE_QUERY.length || keys.some((key, index) => key !== CHROME_SSE_QUERY[index])) return deny("event stream query shape is not allowlisted");
    if (url.searchParams.get("version") !== CHROME_EXTENSION_VERSION || !CHROME_SSE_REV.test(url.searchParams.get("localRev") ?? "") ||
      [...url.searchParams.values()].some((value) => value.length > 128)) return deny("event stream query values are not allowlisted");
    return { consumes: "none" };
  }

  #obsUrl(request: ChromeObsRequest): URL {
    if (typeof request?.url !== "string") return deny("malformed OBS request");
    const url = new URL(request.url);
    if (url.origin !== CHROME_OBS_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "") {
      return deny("OBS host is not the pinned obs.line-apps.com");
    }
    return url;
  }
  #assertObsHeaders(headers: ChromeHeaders): void {
    if (chromeHeader(headers, "x-line-application") !== OBS_APPLICATION_HEADER) return deny("OBS requests carry the pinned X-Line-Application");
    const access = chromeHeader(headers, "x-line-access");
    if (access === undefined || access === "") return deny("OBS requests carry an access token");
    if (chromeHeader(headers, "cookie") !== undefined) return deny("OBS requests never carry a cookie");
  }

  #issueTicket(owner: object, alive: () => boolean, method: string, url: string, headers: ChromeHeaders, body: unknown): void {
    const key = ticketKey(method, url, headers, body);
    const now = this.#now();
    const live = (this.#tickets.get(key) ?? []).filter((ticket) => ticket.expiresAt > now && ticket.alive());
    live.push({ expiresAt: now + CHROME_TICKET_TTL_MS, owner, alive });
    this.#tickets.set(key, live);
    if (this.#tickets.size > 256) {
      for (const [stale, tickets] of this.#tickets) if (tickets.every((ticket) => ticket.expiresAt <= now || !ticket.alive())) this.#tickets.delete(stale);
    }
  }
  /** Deletes every ticket that a permit or media scope issued. */
  #dropTickets(owner: object): void {
    for (const [key, tickets] of this.#tickets) {
      const kept = tickets.filter((ticket) => ticket.owner !== owner);
      if (kept.length === 0) this.#tickets.delete(key); else if (kept.length !== tickets.length) this.#tickets.set(key, kept);
    }
  }
  #bindLease(lease: ControlLease | undefined, phase: string): ControlLease {
    const bound = copyLease(lease, phase);
    if (bound.accountId !== this.#accountId || bound.workerInstanceId !== this.#workerInstanceId) return deny("control lease identity mismatch");
    if (this.#controlEpoch !== undefined && bound.controlEpoch !== this.#controlEpoch) return deny("control lease epoch mismatch");
    return bound;
  }
  async #assertCurrentLease(lease: ControlLease, phase: ControlLeasePhase): Promise<void> {
    if (!await this.#validateControlLease(lease, phase)) deny("control lease is stale or revoked");
  }
}

/** One approval of one physical request. `alive` is false once the permit or scope that issued it has ended. */
type ChromeTicket = Readonly<{ expiresAt: number; owner: object; alive: () => boolean }>;

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Header pairs in wire order, from whatever shape `fetch` receives. */
function headerPairsOf(headers: unknown): Array<readonly [string, string]> {
  if (headers === undefined || headers === null) return [];
  if (Array.isArray(headers)) return headers.map((pair) => [String(pair[0]), String(pair[1])] as const);
  if (typeof (headers as Headers).entries === "function") return [...(headers as Headers).entries()].map(([name, value]) => [name, value] as const);
  return Object.entries(headers as Record<string, unknown>).map(([name, value]) => [name, String(value)] as const);
}

/** A string body stays as it is. A binary body is bound by its length and SHA-256. */
function bodyPartOf(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return `S:${body}`;
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return `U:${bytes.length}:${sha256Hex(bytes)}`;
  }
  if (body instanceof ArrayBuffer) return `U:${body.byteLength}:${sha256Hex(new Uint8Array(body))}`;
  return `O:${typeof body}`;
}

function ticketKey(method: string, url: string, headers: unknown, body: unknown): string {
  const canonical = headerPairsOf(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).join("\n");
  return `${method.toUpperCase()} ${url}\nH:${sha256Hex(canonical)}\nB:${bodyPartOf(body)}`;
}

export function createChromeMutationGate(options: ChromeMutationGateOptions): ChromeMutationGate {
  return new ChromeMutationGate(options);
}
