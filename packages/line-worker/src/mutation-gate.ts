import { AsyncLocalStorage } from "node:async_hooks";

export type EffectPhase = "AUTH_BOOTSTRAP" | "MONITOR_READ" | "CONTROL_READ" | "CONTROL_SEND" | "MANUAL_SEND" | "CHAT_RESOURCE_BOOTSTRAP";
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
/** Per-send OBS upload permit: bound to one lease, at most 2 POSTs, each path once. */
export type MediaUploadScope = Readonly<{ kind: MediaUploadKind; lease: ControlLease; manual: boolean; close(): void }>;
type MediaUploadState = { closed: boolean; posts: number; readonly paths: Set<string>; manual: boolean };
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
    const photoMatch = /^\/oa\/r\/album\/(a|v)\/([A-Za-z0-9_-]{1,256})$/.exec(path);
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
