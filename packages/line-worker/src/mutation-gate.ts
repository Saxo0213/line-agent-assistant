import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ALBUM_CHANNEL_ID, ALBUM_PREVIEW_TID, CHROME_EXTENSION_VERSION, GATEWAY_BASE_URL, OBS_APPLICATION_HEADER, OBS_BASE_URL, USED_ENDPOINTS, specialPath, thriftPath,
  type EndpointAccess, type EndpointUsage, type PhysicalRequest, type ThriftEndpointKey } from "@line-agent/line-chrome";

export type EffectPhase = "AUTH_BOOTSTRAP" | "MONITOR_READ" | "CONTROL_READ" | "CONTROL_SEND" | "MANUAL_SEND" | "CHAT_RESOURCE_BOOTSTRAP" | "SERVER_LOGOUT";
export type ControlLeasePhase = "CONTROL_READ" | "CONTROL_SEND" | "MANUAL_SEND";
export type ControlLease = Readonly<{ accountId: string; workerInstanceId: string; controlEpoch: number }>;
export type RpcTransportState =
  | Readonly<{ mode: "direct"; tokenState: "none" | "v3-jwt" | "legacy-opaque" }>
  | Readonly<{ mode: "legy-encrypted"; tokenState: "v3-jwt" }>
  | Readonly<{ mode: "unsupported"; tokenState: "legacy-opaque" }>;
export type ChatResourceChannelBootstrap = Readonly<{ accountId: string; workerInstanceId: string; controlEpoch: number;
  channelId: '1341209850' | '1375220249'; signal: AbortSignal; maxBytes: number }>;
export type RpcCallContext = Readonly<{ phase: EffectPhase; lease?: ControlLease; allowLegacyOpaqueDirect?: boolean;
  chatResourceBootstrap?: ChatResourceChannelBootstrap }>;
export type DirectFetchEffect = Readonly<{ phase: "MONITOR_READ" | "CONTROL_READ"; lease?: ControlLease }>;
export type ChatResourceFetchEffect = Readonly<{ accountId: string; workerInstanceId: string; controlEpoch: number;
  signal: AbortSignal; maxBytes: number; chatId: string; ownMid: string;
  action: 'listNotes' | 'getNote' | 'listAlbums' | 'listAlbumPhotos' | 'downloadAlbumPhoto';
  cursor?: string | null; postId?: string; albumId?: string; oid?: string; prefix?: 'album/a' | 'album/v'; lease?: ControlLease }>;

export type TrustedRpcInvocation<RpcResult, TransportResult> = Readonly<{
  /** Values actually consumed by the trusted RequestClient serializer. */
  actualMethodName: string;
  actualPath: string;
  transport: RpcTransportState;
  logicalRequest: Request;
  actualValue?: unknown;
  execute(customFetch: (request: Request) => Promise<TransportResult>): Promise<RpcResult>;
}>;
export type TrustedInvocationDispatch<RpcResult, TransportResult> =
  (invocation: TrustedRpcInvocation<RpcResult, TransportResult>) => Promise<RpcResult>;
export type TrustedRequestClient<Call, RpcResult, TransportResult> = Readonly<{
  invoke(call: Call, dispatch: TrustedInvocationDispatch<RpcResult, TransportResult>): Promise<RpcResult>;
}>;
export type MutationGateOptions<Call, RpcResult, TransportResult> = Readonly<{
  accountId: string;
  workerInstanceId: string;
  controlEpoch?: number;
  validateControlLease: (lease: ControlLease, phase: ControlLeasePhase) => boolean | Promise<boolean>;
  requestClient: TrustedRequestClient<Call, RpcResult, TransportResult>;
  physicalTransport: (request: Request) => Promise<TransportResult>;
}>;

export class EffectDeniedError extends Error {
  readonly code = "SIDE_EFFECT_DENIED";
  constructor(readonly reason: string) {
    super(`LINE effect denied: ${reason}`);
    this.name = "EffectDeniedError";
  }
}

const LINE_RPC_HOST = "legy.line-apps.com";
const LEGY_OUTER_URL = "https://gf.line.naver.jp/enc";
const rpcKey = (path: string, rpc: string): string => `${path}\u0000${rpc}`;
const AUTH_BOOTSTRAP_RPC = new Set([
  rpcKey("/acct/lgn/sq/v1", "createSession"),
  rpcKey("/acct/lgn/sq/v1", "createQrCodeForSecure"),
  rpcKey("/acct/lp/lgn/sq/v1", "checkQrCodeVerified"),
  rpcKey("/acct/lgn/sq/v1", "verifyCertificate"),
  rpcKey("/acct/lgn/sq/v1", "createPinCode"),
  rpcKey("/acct/lp/lgn/sq/v1", "checkPinCodeVerified"),
  rpcKey("/acct/lgn/sq/v1", "qrCodeLoginV2ForSecure"),
  rpcKey("/EXT/auth/tokenrefresh/v1", "refresh"),
  rpcKey("/S4", "getProfile"),
  rpcKey("/S4", "getE2EEPublicKeys"),
  rpcKey("/S4", "registerE2EEPublicKey"),
]);
const READ_RPC = new Set([
  rpcKey("/SYNC4", "sync"),
  ...["getProfile", "getContact", "getContacts", "getContactsV2", "getChats",
    "getAllChatMids", "getMessageBoxes", "getPreviousMessagesV2WithRequest",
    "getRecentMessagesV2", "getE2EEPublicKey", "getE2EEPublicKeys",
    "getE2EEGroupSharedKey", "getLastE2EEGroupSharedKey", "getLastE2EEPublicKeys",
    "negotiateE2EEPublicKey", "getServerTime", "acquireEncryptedAccessToken"].map((rpc) => rpcKey("/S4", rpc)),
  rpcKey("/EXT/auth/tokenrefresh/v1", "refresh"),
  rpcKey("/EXT/auth/tokenrefresh/v1", "reportRefreshedAccessToken"),
]);
const CONTROL_READ_RPC = new Set([...READ_RPC, rpcKey("/RE4", "getUserFriendIds"), rpcKey("/RE4", "getFriendDetails")]);
const MONITOR_READ_RPC = new Set(READ_RPC);
const CONTROL_SEND_RPC = new Set([rpcKey("/S4", "sendMessage"), rpcKey("/S4", "react"), rpcKey("/S4", "unsendMessage"),
  rpcKey("/S4", "cancelReaction"), rpcKey("/RE4", "addFriendByMid")]);

/** True only for RPCs already admitted by the read phases. Used to block native read-retry from replaying writes. */
export function isReadOnlyRpc(path: string, methodName: string): boolean {
  return CONTROL_READ_RPC.has(rpcKey(path, methodName));
}

const IDENTIFIER_WITH_DIGIT = "(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const OBS_MESSAGE_PATH = new RegExp(`^/r/(?:talk|g2)/m/${IDENTIFIER_WITH_DIGIT}(?:/preview|/object_info\\.obs|/original)?$`);
const OBS_E2EE_PATH = new RegExp(`^/r/talk/(?:emi|emv|ema|emf)/${IDENTIFIER_WITH_DIGIT}$`);
const OBS_E2EE_PREFLIGHT_PATH = new RegExp(`^/r/talk/(?:emi|emv|ema|emf)/${IDENTIFIER_WITH_DIGIT}/object_info\\.obs$`);
const OBS_UPLOAD_PATH = /^\/r\/talk\/(emi|emf)\/reqid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBS_UPLOAD_PREVIEW_PATH = new RegExp(`^/r/talk/emi/${IDENTIFIER_WITH_DIGIT}__ud-preview$`);
export type MediaUploadKind = "image" | "file";
export type ServerLogoutPermit = Readonly<object>;
/** Per-send OBS upload permit: bound to one lease, at most 2 POSTs, each path once. */
export type MediaUploadScope = Readonly<{ kind: MediaUploadKind; lease: ControlLease; manual: boolean; close(): void }>;
type MediaUploadState = { closed: boolean; posts: number; readonly paths: Set<string>; manual: boolean };
type ServerLogoutState = { readonly token: string; consumed: boolean };
type PhysicalBinding = Readonly<{ url: string; sameAsLogical: boolean }>;
type RpcPermit = {
  active: boolean;
  phase: EffectPhase;
  lease?: ControlLease;
  binding: PhysicalBinding;
  logicalRequest: Request;
  writeConsumed: boolean;
  signal?: AbortSignal;
};

function deny(reason: string): never { throw new EffectDeniedError(reason); }
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("LINE server logout aborted");
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error("LINE server logout aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function assertIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) deny(`${field} must be a non-empty string`);
}
function copyLease(lease: ControlLease | undefined, phase: string): ControlLease {
  if (lease === undefined) return deny(`${phase} requires a control lease`);
  assertIdentity(lease.accountId, "lease.accountId");
  assertIdentity(lease.workerInstanceId, "lease.workerInstanceId");
  if (!Number.isSafeInteger(lease.controlEpoch) || lease.controlEpoch < 0) return deny("invalid control epoch");
  return Object.freeze({ ...lease });
}

export class MutationGate<Call, RpcResult, TransportResult> {
  readonly #accountId: string;
  readonly #workerInstanceId: string;
  readonly #controlEpoch: number | undefined;
  readonly #validateControlLease: MutationGateOptions<Call, RpcResult, TransportResult>["validateControlLease"];
  readonly #requestClient: TrustedRequestClient<Call, RpcResult, TransportResult>;
  readonly #physicalTransport: MutationGateOptions<Call, RpcResult, TransportResult>["physicalTransport"];
  readonly #rpcContext = new AsyncLocalStorage<RpcPermit>();
  readonly #mediaScopes = new WeakMap<MediaUploadScope, MediaUploadState>();
  readonly #serverLogoutPermits = new WeakMap<ServerLogoutPermit, ServerLogoutState>();

  constructor(options: MutationGateOptions<Call, RpcResult, TransportResult>) {
    assertIdentity(options.accountId, "accountId");
    assertIdentity(options.workerInstanceId, "workerInstanceId");
    if (typeof options.requestClient?.invoke !== "function") deny("trusted RequestClient is required");
    if (typeof options.physicalTransport !== "function") deny("trusted physical transport is required");
    this.#accountId = options.accountId;
    this.#workerInstanceId = options.workerInstanceId;
    this.#controlEpoch = options.controlEpoch;
    this.#validateControlLease = options.validateControlLease;
    this.#requestClient = options.requestClient;
    this.#physicalTransport = options.physicalTransport;
  }

  /** Public callers supply only an opaque adapter call, never method metadata or Requests. */
  async invokeRpc(context: RpcCallContext, call: Call): Promise<RpcResult> {
    return this.#requestClient.invoke(call, async (invocation) => {
      const logicalPath = this.#validateInvocation(context, invocation);
      const lease = context.phase === "CONTROL_SEND" || context.phase === "CONTROL_READ" || context.phase === "MANUAL_SEND"
        ? this.#bindLease(context.lease, context.phase) : undefined;
      const permit: RpcPermit = {
        active: true,
        phase: context.phase,
        ...(lease === undefined ? {} : { lease }),
        binding: this.#expectedPhysicalBinding(
          invocation.transport,
          context.phase,
          logicalPath,
          invocation.actualMethodName,
          invocation.logicalRequest.url,
          context.allowLegacyOpaqueDirect === true,
        ),
        logicalRequest: invocation.logicalRequest,
        writeConsumed: false,
        ...(context.chatResourceBootstrap ? { signal: context.chatResourceBootstrap.signal } : {}),
      };
      try {
        return await this.#rpcContext.run(permit, () => invocation.execute(this.#guardedRpcFetch));
      } finally {
        permit.active = false;
      }
    });
  }

  async runFetch(effect: DirectFetchEffect, request: Request): Promise<TransportResult> {
    if (effect.phase !== "MONITOR_READ" && effect.phase !== "CONTROL_READ") return deny("direct fetch is not allowed in this phase");
    this.#assertObsRequest(request);
    if (effect.phase === "CONTROL_READ") await this.#assertCurrentLease(this.#bindLease(effect.lease, effect.phase), "CONTROL_READ");
    return this.#physicalTransport(request);
  }

  /** Create one adapter-owned permit for one server logout invocation. */
  createServerLogoutPermit(existingToken: string): ServerLogoutPermit {
    if (typeof existingToken !== "string" || existingToken.length === 0) return deny("server logout requires an existing token");
    const permit = Object.freeze({});
    this.#serverLogoutPermits.set(permit, { token: existingToken, consumed: false });
    return permit;
  }

  /** One adapter-owned POST to the exact logoutZ endpoint and serializer payload. */
  async runServerLogout(request: Request, permit: ServerLogoutPermit, signal?: AbortSignal): Promise<TransportResult> {
    const state = this.#serverLogoutPermits.get(permit);
    if (!state || state.consumed) return deny("server logout permit is missing or consumed");
    throwIfAborted(signal);
    if (!(request instanceof Request) || request.method !== "POST" || request.redirect === "manual") {
      return deny("server logout must be a POST request");
    }
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== LINE_RPC_HOST || url.port !== "" || url.username !== "" ||
      url.password !== "" || url.pathname !== "/RS4" || url.search !== "" || url.hash !== "") {
      return deny("server logout endpoint is not allowlisted");
    }
    if (request.headers.get("x-line-access") !== state.token) return deny("server logout token does not match the existing token");
    const expectedBody = new Uint8Array([0x82, 0x21, 0x00, 0x07, 0x6c, 0x6f, 0x67, 0x6f, 0x75, 0x74, 0x5a, 0x00]);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    if (body.length !== expectedBody.length || body.some((value, index) => value !== expectedBody[index])) {
      return deny("server logout payload is not the pinned logoutZ payload");
    }
    // Consume before invoking the transport so re-entrant calls cannot reuse it.
    state.consumed = true;
    const physicalRequest = new Request(request, { redirect: "error", ...(signal ? { signal } : {}) });
    return abortable(this.#physicalTransport(physicalRequest), signal);
  }

  /** Narrow direct-fetch permit for LINEJS Notes/Moa calls. It is identity-bound and single-request. */
  async runChatResourceFetch(effect: ChatResourceFetchEffect, request: Request): Promise<TransportResult> {
    if (effect.accountId !== this.#accountId || effect.workerInstanceId !== this.#workerInstanceId ||
      !Number.isSafeInteger(effect.controlEpoch) || effect.controlEpoch < 0 ||
      (this.#controlEpoch !== undefined && effect.controlEpoch !== this.#controlEpoch)) return deny("chat resource worker binding mismatch");
    if (!(effect.signal instanceof AbortSignal) || effect.signal.aborted) return deny("chat resource request is cancelled");
    if (!Number.isSafeInteger(effect.maxBytes) || effect.maxBytes < 1 || effect.maxBytes > 20 * 1024 * 1024) return deny("chat resource response bound is invalid");
    if (effect.lease) {
      const lease = this.#bindLease(effect.lease, "CONTROL_READ");
      if (lease.controlEpoch !== effect.controlEpoch) return deny("chat resource lease epoch mismatch");
      await this.#assertCurrentLease(lease, "CONTROL_READ");
    }
    await this.#assertChatResourceRequest(effect, request);
    if (effect.signal.aborted) return deny("chat resource request is cancelled");
    return this.#physicalTransport(request);
  }

  /** Opens the only context in which an OBS upload POST may pass. The caller closes it in `finally`. */
  openMediaUploadScope(lease: ControlLease, kind: MediaUploadKind, manual = false): MediaUploadScope {
    const phase = manual ? "MANUAL_SEND" : "CONTROL_SEND";
    const bound = this.#bindLease(lease, phase);
    if (kind !== "image" && kind !== "file") return deny("unknown media kind");
    const state: MediaUploadState = { closed: false, posts: 0, paths: new Set(), manual };
    const scope: MediaUploadScope = Object.freeze({ kind, lease: bound, manual, close: () => { state.closed = true; } });
    this.#mediaScopes.set(scope, state);
    return scope;
  }

  async runMediaUpload(scope: MediaUploadScope, request: Request): Promise<TransportResult> {
    const state = this.#mediaScopes.get(scope);
    if (state === undefined || state.closed) return deny("media upload has no open scope");
    if (!(request instanceof Request) || request.method !== "POST" || request.redirect !== "error") {
      return deny("media upload must be a redirect-blocked POST");
    }
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== "obs.line-apps.com" || url.port !== "" ||
      url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return deny("media upload host/url is not allowlisted");
    }
    const match = OBS_UPLOAD_PATH.exec(url.pathname);
    const allowed = match !== null ? match[1] === (scope.kind === "image" ? "emi" : "emf")
      : scope.kind === "image" && OBS_UPLOAD_PREVIEW_PATH.test(url.pathname);
    if (!allowed) return deny("media upload path is not allowlisted");
    if (state.posts >= 2 || state.paths.has(url.pathname)) return deny("media upload scope limit reached");
    if (scope.kind === "file" && state.posts >= 1) return deny("media upload scope limit reached");
    // Reserve synchronously so concurrent reuse of the same path cannot pass the async lease check.
    state.posts += 1;
    state.paths.add(url.pathname);
    await this.#assertCurrentLease(scope.lease, state.manual ? "MANUAL_SEND" : "CONTROL_SEND");
    if (state.closed) return deny("media upload scope closed");
    return this.#physicalTransport(request);
  }

  readonly #guardedRpcFetch = async (request: Request): Promise<TransportResult> => {
    const permit = this.#rpcContext.getStore();
    if (permit === undefined || !permit.active) return deny("RPC physical fetch has no active RequestClient permit");
    const isWrite = permit.phase === "CONTROL_SEND" || permit.phase === "MANUAL_SEND";
    if (isWrite && permit.writeConsumed) return deny(`${permit.phase} permit is single-use; retry is unknown`);
    this.#assertPhysicalRpcRequest(request, permit);
    if (permit.signal?.aborted) return deny("chat resource channel-token bootstrap was cancelled");
    if (permit.lease !== undefined && (permit.phase === "CONTROL_READ" || permit.phase === "CONTROL_SEND" || permit.phase === "MANUAL_SEND")) {
      await this.#assertCurrentLease(permit.lease, permit.phase);
    }
    // A single-use permit can be exercised concurrently. Recheck after the
    // async lease validator and consume synchronously before transport.
    if (isWrite) {
      if (permit.writeConsumed) return deny(`${permit.phase} permit is single-use; retry is unknown`);
      permit.writeConsumed = true;
    }
    if (permit.signal) return this.#physicalTransport(new Request(request, { signal: permit.signal, redirect: "error" }));
    return this.#physicalTransport(request);
  };

  #validateInvocation(context: RpcCallContext, invocation: TrustedRpcInvocation<RpcResult, TransportResult>): string {
    assertIdentity(invocation.actualMethodName, "actualMethodName");
    assertIdentity(invocation.actualPath, "actualPath");
    if (typeof invocation.execute !== "function") return deny("trusted RequestClient invocation is incomplete");
    const request = invocation.logicalRequest;
    if (!(request instanceof Request) || request.method !== "POST") return deny("logical RPC must be a POST Request");
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== LINE_RPC_HOST || url.port !== "" ||
      url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
      url.pathname !== invocation.actualPath) return deny("logical RPC host/path drifted from trusted serializer");
    const key = rpcKey(invocation.actualPath, invocation.actualMethodName);
    const resourceBootstrap = context.chatResourceBootstrap;
    if (context.phase === "CHAT_RESOURCE_BOOTSTRAP") {
      if (!resourceBootstrap || resourceBootstrap.accountId !== this.#accountId || resourceBootstrap.workerInstanceId !== this.#workerInstanceId ||
        !Number.isSafeInteger(resourceBootstrap.controlEpoch) || resourceBootstrap.controlEpoch < 0 ||
        (this.#controlEpoch !== undefined && resourceBootstrap.controlEpoch !== this.#controlEpoch) ||
        !["1341209850", "1375220249"].includes(resourceBootstrap.channelId) ||
        !(resourceBootstrap.signal instanceof AbortSignal) || resourceBootstrap.signal.aborted ||
        !Number.isSafeInteger(resourceBootstrap.maxBytes) || resourceBootstrap.maxBytes < 1 || resourceBootstrap.maxBytes > 64 * 1024 ||
        invocation.actualPath !== "/CH4" || invocation.actualMethodName !== "approveChannelAndIssueChannelToken" ||
        !this.#isChannelTokenArgs(invocation.actualValue, resourceBootstrap.channelId)) {
        return deny("resource channel-token bootstrap is not allowlisted");
      }
      return invocation.actualPath;
    }
    if (resourceBootstrap) return deny("resource channel-token context requires CHAT_RESOURCE_BOOTSTRAP phase");
    const opaqueDownloadRead = context.allowLegacyOpaqueDirect === true && context.phase === "MONITOR_READ" &&
      invocation.actualPath === "/S4" &&
      (invocation.actualMethodName === "getProfile" || invocation.actualMethodName === "acquireEncryptedAccessToken");
    if (context.allowLegacyOpaqueDirect === true && !opaqueDownloadRead) {
      return deny("opaque direct access is restricted to native download profile/token reads");
    }
    let allowed: boolean;
    switch (context.phase) {
      case "AUTH_BOOTSTRAP": allowed = AUTH_BOOTSTRAP_RPC.has(key); break;
      case "MONITOR_READ": allowed = MONITOR_READ_RPC.has(key); break;
      case "CONTROL_READ": allowed = CONTROL_READ_RPC.has(key); break;
      case "CONTROL_SEND": allowed = CONTROL_SEND_RPC.has(key); break;
      case "MANUAL_SEND": allowed = key === rpcKey("/S4", "sendMessage") || key === rpcKey("/S4", "unsendMessage"); break;
      default: return deny("unknown effect phase");
    }
    if (!allowed) return deny(`RPC is not allowlisted for ${context.phase}`);
    return invocation.actualPath;
  }

  #isChannelTokenArgs(value: unknown, channelId: string): boolean {
    if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) return false;
    const args = value[0];
    return args.length === 3 && args[0] === 11 && args[1] === 1 && args[2] === channelId;
  }

  #expectedPhysicalBinding(
    transport: RpcTransportState,
    phase: EffectPhase,
    logicalPath: string,
    methodName: string,
    logicalUrl: string,
    allowLegacyOpaqueDirect: boolean,
  ): PhysicalBinding {
    if (transport.mode === "unsupported") return deny("legacy opaque token transport is unsupported");
    const opaqueDownloadRead = allowLegacyOpaqueDirect && phase === "MONITOR_READ" && logicalPath === "/S4" &&
      (methodName === "getProfile" || methodName === "acquireEncryptedAccessToken");
    if (transport.tokenState === "legacy-opaque" && !opaqueDownloadRead) {
      return deny("legacy opaque token transport is unsupported");
    }
    const talk = logicalPath === "/S4" || logicalPath === "/SYNC4";
    if (transport.mode === "legy-encrypted") {
      if (transport.tokenState !== "v3-jwt" || !talk) return deny("LEGY encrypted mode/token/path mismatch");
      return { url: LEGY_OUTER_URL, sameAsLogical: false };
    }
    if (transport.tokenState === "none") {
      if (phase !== "AUTH_BOOTSTRAP") return deny("tokenless direct RPC is restricted to bootstrap");
      if (logicalPath === "/S4" && methodName !== "registerE2EEPublicKey") {
        return deny("tokenless Talk bootstrap is restricted to QR public-key registration");
      }
      return { url: logicalUrl, sameAsLogical: true };
    }
    if (transport.tokenState === "legacy-opaque") {
      if (!opaqueDownloadRead || phase !== "MONITOR_READ" || !talk) return deny("opaque direct RPC is restricted to native download reads");
      return { url: logicalUrl, sameAsLogical: true };
    }
    if (talk) return deny("V3 Talk RPC must use the verified LEGY outer transport");
    return { url: logicalUrl, sameAsLogical: true };
  }

  #bindLease(lease: ControlLease | undefined, phase: string): ControlLease {
    const bound = copyLease(lease, phase);
    if (bound.accountId !== this.#accountId || bound.workerInstanceId !== this.#workerInstanceId) return deny("control lease identity mismatch");
    return bound;
  }
  async #assertCurrentLease(lease: ControlLease, phase: ControlLeasePhase): Promise<void> {
    if (!await this.#validateControlLease(lease, phase)) deny("control lease is stale or revoked");
  }
  #assertPhysicalRpcRequest(request: Request, permit: RpcPermit): void {
    if (!(request instanceof Request) || request.method !== "POST" || request.url !== permit.binding.url ||
      (permit.binding.sameAsLogical && request !== permit.logicalRequest)) deny("physical RPC request drifted from bound permit");
  }
  #assertObsRequest(request: Request): void {
    if (!(request instanceof Request)) return deny("direct fetch must be a Request");
    if (request.method !== "GET" || request.redirect !== "error") return deny("direct fetch must be a redirect-blocked GET");
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== "obs.line-apps.com" || url.port !== "" ||
      url.username !== "" || url.password !== "" || url.hash !== "" ||
      (!OBS_MESSAGE_PATH.test(url.pathname) && !OBS_E2EE_PATH.test(url.pathname) && !OBS_E2EE_PREFLIGHT_PATH.test(url.pathname)))
      return deny("direct fetch host/path is not allowlisted");
    if (url.search !== "") {
      const pop = url.searchParams.getAll("p");
      if (!/^\?p=[A-Za-z0-9._~+%-]{1,768}$/.test(url.search) || pop.length !== 1 || url.searchParams.size !== 1 ||
        pop[0]!.length === 0 || pop[0]!.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(pop[0]!)) {
        return deny("OBS query is not one bounded POP value");
      }
    }
  }
  async #assertChatResourceRequest(effect: ChatResourceFetchEffect, request: Request): Promise<void> {
    if (!(request instanceof Request) || request.redirect !== "error") return deny("chat resource fetch must block redirects");
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== "legy.line-apps.com" || url.port !== "" ||
      url.username !== "" || url.password !== "" || url.hash !== "" || url.href.length > 8192 ||
      [...url.searchParams.values()].some((value) => value.length > 2048)) return deny("chat resource host is not allowlisted");
    const path = url.pathname;
    const noteMatch = /^(\/(?:mh|sn)\/api\/v57\/post\/(list|get)\.json)$/.exec(path);
    const albumListPath = path === "/ext/album/moa/v2/albums";
    const albumPhotosMatch = /^\/ext\/album\/api\/v6\/albums\/([A-Za-z0-9_-]{1,128})\/photos$/.exec(path);
    const photoMatch = /^\/oa\/r\/album\/(a|v)\/((?=[A-Za-z0-9._-]{1,256}$)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)$/.exec(path);
    const notePath = noteMatch !== null;
    const albumsPath = albumListPath || albumPhotosMatch !== null;
    const photoPath = photoMatch !== null;
    if (!notePath && !albumsPath && !photoPath) return deny("chat resource path is not allowlisted");
    const channelToken = request.headers.get("X-Line-ChannelToken");
    if (!channelToken || channelToken.length > 2048) return deny("chat resource channel token is missing or invalid");
    if (notePath) {
      const homeId = url.searchParams.get("homeId");
      const isGet = noteMatch![2] === "get";
      if (request.method !== "GET" || (isGet ? url.searchParams.size !== 2 : url.searchParams.size < 4 || url.searchParams.size > 6) ||
        [...url.searchParams.keys()].some((key) => !["homeId", "postId", "updatedTime", "sourceType", "likeLimit", "commentLimit"].includes(key)) ||
        new Set(url.searchParams.keys()).size !== url.searchParams.size ||
        homeId !== effect.chatId || (path.startsWith("/sn/") !== homeId.startsWith("s")) ||
        (effect.action === "listNotes" ? noteMatch![2] !== "list" : effect.action === "getNote" ? noteMatch![2] !== "get" : true) ||
        request.headers.get("X-Line-Mid") !== effect.ownMid || (isGet && !url.searchParams.has("postId")) || (!isGet && (
          url.searchParams.get("sourceType") !== "TALKROOM" || url.searchParams.get("likeLimit") !== "0" || url.searchParams.get("commentLimit") !== "0"))) {
        return deny("Note request shape is not allowlisted");
      }
      if (isGet ? url.searchParams.get("postId") !== effect.postId
        : url.searchParams.get("postId") !== (effect.cursor ?? null)) return deny("Note request is not bound to the requested post cursor");
      return;
    }
    if (albumsPath) {
      const queryKeys = [...url.searchParams.keys()];
      const albumList = albumListPath;
      const allowedKeys = albumList ? ["cursor", "orderBy", "include"] : ["cursor", "pageSize", "orderBy", "include", "filterType", "targetUser"];
      if (request.method !== "POST" || queryKeys.length < (albumList ? 2 : 4) || queryKeys.some((key) => !allowedKeys.includes(key)) ||
        (effect.action !== (albumList ? "listAlbums" : "listAlbumPhotos")) || request.body === null || (await request.clone().arrayBuffer()).byteLength !== 0 ||
        [...new Set(queryKeys)].length !== queryKeys.length || [...url.searchParams.values()].some((value) => value.length > 2048)) return deny("Album request shape is not allowlisted");
      if (request.headers.get("X-Line-Mid") !== effect.ownMid || (!albumList &&
        (request.headers.get("X-Line-Chat-Id") !== effect.chatId || albumPhotosMatch![1] !== effect.albumId))) {
        return deny("Album photo request is not bound to the selected chat and album");
      }
      return;
    }
    if (request.method !== "POST" || url.search !== "" || request.body === null || (await request.clone().arrayBuffer()).byteLength !== 0 ||
      effect.action !== "downloadAlbumPhoto" || photoMatch![2] !== effect.oid || photoMatch![1] !== effect.prefix?.slice(-1) ||
      request.headers.get("X-Line-Mid") !== effect.chatId || request.headers.get("X-Line-Album") !== effect.albumId) {
      return deny("Album photo request must be empty-body POST without query");
    }
  }
}

export function createMutationGate<Call, RpcResult, TransportResult>(
  options: MutationGateOptions<Call, RpcResult, TransportResult>,
): MutationGate<Call, RpcResult, TransportResult> {
  return new MutationGate(options);
}

// ---------------------------------------------------------------------------------------------------------------------
// CHROMEOS profile (LINE Chrome extension 3.7.2 transport). Everything above this line is the DESKTOPWIN profile and is
// unchanged. The two profiles share the phases, the lease rules and the single-use write permit, but not the allowlists:
// CHROMEOS requests are plain JSON over HTTPS to two fixed hosts, so they are authorised from the `PhysicalRequest` that
// the line-chrome gateway hands to its `beforeRequest` hook, and the network call itself is wrapped by `guardFetch`, which
// only forwards a request that a hook approved moments before.
// ---------------------------------------------------------------------------------------------------------------------

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
