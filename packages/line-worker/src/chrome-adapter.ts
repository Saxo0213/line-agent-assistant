// CHROMEOS (LINE Chrome extension 3.7.2) implementation of `LineTransport`. The protocol lives in @line-agent/line-chrome;
// this file adapts it to the worker: the three secret slots, the worker events, the mutation gate and poll/ack.
//
// Reads (login, catalog, profile, sync, history) came with step 5; step 6 adds the writes and the OBS media paths: send,
// sendMedia, download, react, unsend, checkFriendRelation and addFriendByMid. Step 7 adds `readChatResource`: only the album
// photo download exists (line-cli has no album or photo list, and no notes API exists in any reference); every other action
// raises `ChatResourceUnsupportedError`, which the worker loop reports as `UNSUPPORTED`. `adoptDownloadAuth` and
// `clearDownloadAuth` stay undefined (DESKTOPWIN-only download auth does not exist here).

import { randomUUID } from 'node:crypto';
import {
  ALBUM_CHANNEL_ID, ChannelTokenCache, ChannelTokenError, downloadAlbumPreview,
  ChromeApiError, ChromeE2ee, ChromeGateway, ChromeSessionState, ChromeSseReceiver, ChromeTransportError, FriendCache, FriendListShapeError, FriendListStaleError,
  GatewayE2eeKeyApi, LtsmBridge, LtsmHmacSigner, LtsmStore, LtsmUnavailableError, ObsClient, ObsHttpError, ObsSizeLimitError, ReceiveBuffer,
  CONTENT_TYPE, TokenRefresher, buildAddFriendRequest, buildCancelReactionRequest, buildMediaMessage, buildReactRequest, buildTextMessage,
  buildCatchupItems, buildChromeSyncResult, classifyE2eeSendError, decodeEncKm, decryptBlob, encryptBlob, fetchIdentity,
  generateEncKm, isRetryableE2eeSendError, isSessionKickout, loginWithToken, logoutV2, parseEncryptedAccessToken, qrLogin,
  requiredLtsmPin, pythonTruthy, tagLoginStage, thriftPath, SEALABLE_CONTENT_TYPES, CHROME_EXTENSION_VERSION, E2EE_ERROR_CODE, OBS_GENERAL_FEATURE,
  type ChromeIdentity, type ChromeMessage, type E2eeBridge, type FetchLike, type HmacSigner, type QrLoginBridge,
  type ReactionName, type ReceiveClock, type ReceiverState, type TimerApi,
} from '@line-agent/line-chrome';
import {
  buildMentionContentMetadata, MEDIA_FILE_MAX_BYTES, MEDIA_IMAGE_MAX_BYTES,
  type AccountMode, type ChatResourceReadCommand, type ConversationCatalogItem, type JsonValue, type LineWorkerCommand, type OutgoingMention, type TalkCursorV1Dto,
} from '@line-agent/contracts';
import { EffectDeniedError, type ControlLease, type ControlLeasePhase } from './mutation-gate.js';
import { createChromeMutationGate, type ChromeEffectContext, type ChromeMutationGate } from './chrome-mutation-gate.js';
import { ChromeLtsmUnavailableError } from './chrome-ltsm-error.js';
import {
  MediaUploadFailedError, tagMediaStage, type MediaUploadStage, type FriendAddResult, type FriendRelation, type FriendRelationDiagnostic, type LineTransport,
  type RelationCancellation, type SyncResult, type TransportIdentity,
} from './worker-loop.js';
import type { HistoryCursorV1 } from './cursor.js';
import { SafeAttachmentError } from './attachment-error.js';
import { ChatResourceFailure, ChatResourceUnsupportedError, safeChatResourceUpstreamCode, safeChatResourceUpstreamNumber } from './chat-resource-error.js';
import { validateAttachmentMessage, validateNativeAttachment, type AttachmentDownloadIdentity } from './attachment-download.js';
import { decodeChromeFriendAddRejection, decodeChromeServerRejection } from './chrome-server-error.js';
import { isLineServerRejection } from './line-server-error.js';
import { decryptLinejsHistoryMessages, fetchLinejsConversationCatalog, normalizeLinePicturePath, type DownloadedAttachment } from './linejs-adapter.js';

/** `SyncReason` values from the Chrome registry notes: catalog reads use 4, the message box list uses 2. */
const CATALOG_SYNC_REASON = 4;
const MESSAGE_BOX_SYNC_REASON = 2;
/** `getPreviousMessagesV2WithRequest` sync reason (OkLine `SyncReason.OPERATION`). */
const HISTORY_SYNC_REASON = 3;
const CATALOG_BATCH_SIZE = 100;
const MESSAGE_BOX_PAGE_LIMIT = 100;
const MESSAGE_BOX_MAX_PAGES = 50;
/** First-sighting catch-up caps, identical to the DESKTOPWIN adapter: 5 chats x 20 messages. */
export const CATCHUP_MAX_CHATS = 5;
export const CATCHUP_MESSAGES_PER_CHAT = 20;
/** The worker loop rejects a sync batch above this many operations. */
const SYNC_BATCH_LIMIT = 100;
const DEFAULT_RECEIVE_WAIT_MS = 500;
const ADD_FRIEND_PATH = thriftPath('Relation.RelationService.addFriendByMid');
const INT64_MAX = 9223372036854775807n;

/** The event stream is terminally down (144 failed attempts or an auth rejection). `sync` throws this until it is reopened. */
export class ChromeReceiverDisconnectedError extends Error {
  readonly code = 'CHROME_SSE_DISCONNECTED';
  constructor(readonly authRejected: boolean, readonly failures: number) {
    super('LINE event stream is disconnected'); this.name = 'ChromeReceiverDisconnectedError';
  }
}
/** A cursor written by the DESKTOPWIN transport (non-zero globalRev / individualRev) is never replayed on CHROMEOS. */
export class ChromeForeignCursorError extends Error {
  readonly code = 'CHROME_FOREIGN_CURSOR';
  constructor() { super('cursor belongs to another LINE transport'); this.name = 'ChromeForeignCursorError'; }
}

function assertConversation(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }): void {
  const prefix = { direct: 'u', group: 'c', room: 'r' }[conversation.chatType];
  if (!conversation.chatId.startsWith(prefix)) throw new EffectDeniedError('conversation type/MID mismatch');
}

function assertInt64(messageId: string): void {
  if (!/^(?:0|[1-9][0-9]*)$/.test(messageId) || BigInt(messageId) > INT64_MAX) throw new EffectDeniedError('message ID is not a LINE int64');
}

function messageIdOf(response: unknown): string {
  const id = response !== null && typeof response === 'object' && !Array.isArray(response) ? (response as { id?: unknown }).id : undefined;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  // The write was sent; without an id its outcome cannot be confirmed, so the loop reports it as unknown.
  throw new Error('LINE sendMessage returned no message id');
}

async function* singleChunk(bytes: Buffer): AsyncIterable<Uint8Array> { yield bytes; }

/** A failure while reading the sealed metadata: keep a server code, a dead session and a denial; everything else is one fixed code. */
function attachmentPhaseFailure(error: unknown, rpcCode: 'LINE_E2EE_METADATA_RPC_FAILED', decryptCode: 'LINE_E2EE_METADATA_DECRYPT_FAILED'): unknown {
  if (isSessionKickout(error) || error instanceof EffectDeniedError || error instanceof SafeAttachmentError) return error;
  if (error instanceof ChromeApiError || error instanceof ChromeTransportError) {
    const rejection = decodeChromeServerRejection(error);
    return rejection ? new SafeAttachmentError(rpcCode, rejection.code, rejection.upstreamCode) : new SafeAttachmentError(rpcCode);
  }
  return new SafeAttachmentError(decryptCode);
}

function classifyChromeAttachmentFailure(error: unknown): SafeAttachmentError {
  if (error instanceof SafeAttachmentError) return error;
  if (error instanceof EffectDeniedError) return new SafeAttachmentError('ATTACHMENT_EFFECT_DENIED');
  if (isSessionKickout(error)) return new SafeAttachmentError('LINE_AUTH_INVALIDATED');
  if (error instanceof ObsHttpError) {
    if (error.status === 202) return new SafeAttachmentError('LINE_OBS_ENCODING_INCOMPLETE');
    return new SafeAttachmentError(error.status >= 400 && error.status <= 599 ? `LINE_OBS_HTTP_${error.status}` : 'LINE_OBS_HTTP_FAILED');
  }
  if (error instanceof ObsSizeLimitError) return new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
  if (error instanceof ChromeTransportError || error instanceof TypeError) return new SafeAttachmentError('LINE_NETWORK_FAILED');
  if (error instanceof ChromeApiError) return new SafeAttachmentError('LINE_RPC_FAILED');
  return new SafeAttachmentError('LINE_NATIVE_DOWNLOAD_FAILED');
}

/** Bootstrap (channel token) failures keep only the server's numeric facts; everything else is one fixed kind. */
function chatResourceFailure(category: 'bootstrap_failure' | 'list_get_transport_failure' | 'response_validation', error: unknown): ChatResourceFailure {
  let status: number | undefined;
  let code: ReturnType<typeof safeChatResourceUpstreamCode> | undefined;
  if (error instanceof ObsHttpError) status = safeChatResourceUpstreamNumber(error.status);
  else if (error instanceof ChromeApiError) {
    status = safeChatResourceUpstreamNumber(error.status);
    const inner = error.innerCode ?? error.outerCode ?? error.code;
    if (inner !== undefined) code = safeChatResourceUpstreamCode(inner);
  } else if (error instanceof ChromeTransportError) status = safeChatResourceUpstreamNumber(error.status);
  const kind = error instanceof ChromeTransportError ? (error.timedOut ? 'timeout_error' as const : 'other' as const) : 'other' as const;
  return new ChatResourceFailure(category, undefined, kind, status, code);
}

/** What the E2EE and QR flows need from the ltsm bridge. */
export type ChromeAdapterBridge = E2eeBridge & QrLoginBridge;

export type ChromeAdapterOptions = Readonly<ControlLease & {
  mode: AccountMode;
  validateLease: (lease: ControlLease) => boolean | Promise<boolean>;
  /** Node global fetch (undici) in production. Wrapped by the gate: nothing else reaches the network. */
  fetch: FetchLike;
  /** Store root (`chromeLtsmDir` from init). Needed unless both `signer` and `bridge` are injected. */
  ltsmRoot?: string;
  signer?: HmacSigner;
  bridge?: ChromeAdapterBridge;
  /** Test seams. */
  createE2ee?: (parts: Readonly<{ bridge: ChromeAdapterBridge; api: GatewayE2eeKeyApi; store: ChromeSessionState; now?: () => number }>) => ChromeE2ee;
  receiveWaitMs?: number;
  receiveClock?: ReceiveClock;
  timers?: TimerApi;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseUrl?: string;
}>;

function toJsonInt(value: string): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

export class ChromeAdapter implements LineTransport {
  readonly #options: ChromeAdapterOptions;
  readonly #state = new ChromeSessionState();
  readonly #gate: ChromeMutationGate;
  readonly #gateway: ChromeGateway;
  readonly #refresher: TokenRefresher;
  readonly #buffer: ReceiveBuffer;
  readonly #receiver: ChromeSseReceiver;
  readonly #bridge: ChromeAdapterBridge;
  readonly #signer: HmacSigner;
  readonly #closeable: { close(): void } | undefined;
  readonly #seenConversationIds = new Set<string>();
  /** Catch-up items that did not fit in a sync batch. They go out first at the next sync. */
  #pendingCatchup: unknown[] = [];
  readonly #readReceiptCounters = { readReceiptShapeDropped: 0, readReceiptOverflowDropped: 0 };
  #e2ee: ChromeE2ee;
  #ownMid: string | null = null;
  #revoked = false;
  #serverLogoutStarted = false;
  #lastCursorRevision = '0';
  readonly #friends: FriendCache;
  readonly #fetch: FetchLike;
  #activeRelationAdd: { consumed: boolean; signal: RelationCancellation; onPhysicalStart: () => void } | undefined;
  #reopenOnNextSync = false;
  readonly #channelTokens: ChannelTokenCache;
  /** The encrypted OBS token of this session (OkLine obs.py:113-140). One request serves every OBS operation until a login change or a 401/403. */
  #obsToken: Promise<string> | undefined;

  constructor(options: ChromeAdapterOptions, parts: Readonly<{ signer: HmacSigner; bridge: ChromeAdapterBridge; closeable?: { close(): void } }>) {
    this.#options = options;
    this.#signer = parts.signer;
    this.#bridge = parts.bridge;
    this.#closeable = parts.closeable;
    this.#gate = createChromeMutationGate({
      accountId: options.accountId, workerInstanceId: options.workerInstanceId, controlEpoch: options.controlEpoch,
      // Identical lease rules to the DESKTOPWIN adapter (linejs-adapter.ts validateControlLease).
      validateControlLease: async (lease, phase: ControlLeasePhase) => {
        const identityMatches = lease.accountId === options.accountId &&
          lease.workerInstanceId === options.workerInstanceId && lease.controlEpoch === options.controlEpoch;
        if (!identityMatches) return false;
        if (phase === 'CONTROL_READ') {
          if (this.#revoked || options.mode !== 'ACTIVE_CONTROL') return true;
          return await options.validateLease(lease);
        }
        if (this.#revoked || options.mode === 'PAUSED' || (phase === 'CONTROL_SEND' && options.mode !== 'ACTIVE_CONTROL')) return false;
        const valid = await options.validateLease(lease);
        return valid && !this.#revoked && (phase === 'MANUAL_SEND' || options.mode === 'ACTIVE_CONTROL');
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#friends = new FriendCache(options.now);
    // The physical-start hook of addFriendByMid sits between the gate's ticket check and the network (linejs-adapter.ts:790-799).
    const physicalFetch: FetchLike = async (input, init) => {
      const active = this.#activeRelationAdd;
      if (active !== undefined && new URL(input).pathname === ADD_FRIEND_PATH) {
        if (active.consumed || active.signal.aborted || this.#revoked || this.#options.mode !== 'ACTIVE_CONTROL') {
          throw new EffectDeniedError('Relation add physical effect is no longer available');
        }
        // Consume before the callback and the transport: a re-entrant or second dispatch is denied before the network.
        active.consumed = true;
        active.onPhysicalStart();
      }
      return options.fetch(input, init);
    };
    const guardedFetch = this.#gate.guardFetch(physicalFetch);
    this.#fetch = guardedFetch;
    const shared = {
      fetch: guardedFetch, signer: parts.signer, getAccessToken: () => this.#state.accessToken ?? undefined,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    };
    // Three gateways over one signer and one guarded fetch; they differ only in how their requests are authorised:
    //  - authGateway: token refresh (timer driven, outside any worker call) is AUTH_BOOTSTRAP only;
    //  - gateway: every worker call, authorised against the permit of the surrounding `gate.run`;
    //  - streamGateway: the SSE receiver, a standing read-only context that follows the account mode.
    const authGateway = new ChromeGateway({ ...shared, beforeRequest: this.#gate.beforeRequestFor(() => ({ phase: 'AUTH_BOOTSTRAP' })) });
    this.#refresher = new TokenRefresher({
      state: this.#state, gateway: authGateway,
      onRefreshed: () => { this.#receiver.reconnect(); },
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
    this.#gateway = new ChromeGateway({ ...shared, onMustRefresh: this.#refresher.mustRefreshHook, beforeRequest: this.#gate.beforeRequest() });
    // The stream gateway reads getLastOpRevision for the seed. An inner 119 there must refresh and replay (OkLine operations.py:359-363).
    const streamGateway = new ChromeGateway({ ...shared, onMustRefresh: this.#refresher.mustRefreshHook,
      beforeRequest: this.#gate.beforeRequestFor(() => this.#readContext()) });
    this.#channelTokens = new ChannelTokenCache((channelId, signal) => this.#gateway.call<unknown>('Talk.ChannelService.issueChannelToken',
      [channelId], { mode: 'read', ...(signal === undefined ? {} : { signal }) }), options.now);
    this.#buffer = new ReceiveBuffer(options.receiveClock === undefined ? {} : { clock: options.receiveClock });
    this.#receiver = new ChromeSseReceiver({
      gateway: streamGateway, sink: this.#buffer, getAccessToken: () => this.#state.accessToken ?? undefined,
      ...(options.receiveClock === undefined ? {} : { clock: options.receiveClock }),
    });
    this.#buffer.attach(this.#receiver);
    this.#e2ee = this.#newE2ee();
  }

  /** The state of the event stream (diagnostics and tests). */
  get receiverState(): ReceiverState { return this.#receiver.state; }
  get readReceiptCounters(): Readonly<{ readReceiptShapeDropped: number; readReceiptOverflowDropped: number }> {
    return { ...this.#readReceiptCounters };
  }
  get signer(): HmacSigner { return this.#signer; }
  get bridge(): ChromeAdapterBridge { return this.#bridge; }

  on(event: 'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated' | 'refreshFailure', listener: (value?: any) => void): void {
    this.#state.on(event, listener);
  }

  async installSecrets(secrets: { token: string | null; qrCert: string | null; e2eeStorage: JsonValue | null }): Promise<void> {
    // Validates first: a snapshot of another transport (or a malformed one) throws and leaves the previous state intact.
    this.#state.install(secrets);
    this.#channelTokens.clear();
    this.#receiver.reset();
    this.#obsToken = undefined;
    this.#friends.reset();
    this.#ownMid = this.#state.mid;
    this.#e2ee = this.#newE2ee();
    await this.#e2ee.loadFromState();
    this.#markStreamForReopen();
    this.#refresher.resume();
    this.#refresher.arm();
  }

  async loginQr(): Promise<TransportIdentity> {
    this.#channelTokens.clear();
    this.#obsToken = undefined;
    this.#receiver.reset();
    this.#friends.reset();
    // Stop the old refresh timer and discard a refresh in flight before the token is cleared (OkLine auth.py:916-970).
    this.#refresher.invalidate();
    // The login calls must be signed with the empty token, as OkLine does. An old token would change the X-Hmac.
    this.#state.setAccessToken(null);
    // A thrown error carries the step that started last (a diagnostic only). The first tag stays.
    let stage = 'auth_gate';
    let identity: ChromeIdentity;
    try {
      identity = await this.#run({ phase: 'AUTH_BOOTSTRAP' }, async () => {
        stage = 'qr_login';
        const result = await qrLogin({ gateway: this.#gateway, bridge: this.#bridge, state: this.#state });
        stage = 'e2ee_setup';
        // qrLogin already stored the exported key blobs in the session state; this builds the live key set.
        this.#e2ee = this.#newE2ee();
        if (result.e2ee) this.#e2ee.adoptLogin(result.e2ee);
        stage = 'fetch_identity';
        return await fetchIdentity(this.#gateway, this.#state);
      });
    } catch (error) {
      tagLoginStage(error, stage);
      throw error;
    }
    this.#ownMid = identity.ownMid;
    this.#markStreamForReopen();
    this.#refresher.resume();
    this.#refresher.arm();
    try { return this.#normalizeIdentity(identity); }
    catch (error) { tagLoginStage(error, 'normalize_identity'); throw error; }
  }

  async loginToken(token: string): Promise<TransportIdentity> {
    this.#channelTokens.clear();
    this.#obsToken = undefined;
    this.#receiver.reset();
    this.#friends.reset();
    this.#refresher.resume();
    const identity = await this.#run({ phase: 'AUTH_BOOTSTRAP' }, async () => {
      const resumed = await loginWithToken({ gateway: this.#gateway, state: this.#state, refresher: this.#refresher, token });
      if (!this.#e2ee.isReady()) await this.#e2ee.loadFromState();
      return resumed;
    });
    this.#ownMid = identity.ownMid;
    this.#markStreamForReopen();
    return this.#normalizeIdentity(identity);
  }

  async logoutServer(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('LINE server logout aborted');
    if (this.#serverLogoutStarted) throw new EffectDeniedError('server logout already started');
    const token = this.#state.accessToken;
    if (token === null || token.length === 0) throw new Error('LINE_LOGOUT_NO_TOKEN');
    this.#serverLogoutStarted = true;
    this.#obsToken = undefined;
    try {
      await this.#run({ phase: 'SERVER_LOGOUT', serverLogoutToken: token, signal }, () =>
        logoutV2({ gateway: this.#gateway, state: this.#state, refresher: this.#refresher, signal }));
    } catch (error) {
      this.#serverLogoutStarted = false;
      throw error;
    }
    // Success (including "already kicked out"): the session is over, so nothing may keep running for it.
    this.#refresher.stop();
    this.#receiver.stop();
  }

  async listConversations(): Promise<readonly ConversationCatalogItem[]> {
    this.#assertUsable();
    const talk = {
      ownMid: this.#ownMid ?? '',
      getAllChatMids: () => this.#gateway.call<{ memberChatMids?: unknown }>('Talk.TalkService.getAllChatMids',
        [{ withMemberChats: true, withInvitedChats: true }, CATALOG_SYNC_REASON], { mode: 'read' }),
      getMessageBoxes: () => this.#readMessageBoxes(),
      getChats: ({ chatMids }: { chatMids: string[] }) => this.#gateway.call<{ chats?: readonly never[] }>('Talk.TalkService.getChats',
        [{ chatMids, withMembers: true, withInvitees: true }, CATALOG_SYNC_REASON], { mode: 'read' }),
      getContactsV2: ({ mids }: { mids: string[] }) => this.#gateway.call<{ contacts?: unknown }>('Talk.TalkService.getContactsV2',
        [{ targetUserMids: mids, neededContactCalendarEvents: [] }, CATALOG_SYNC_REASON], { mode: 'read' }),
    };
    return this.#run(this.#readContext(), () => fetchLinejsConversationCatalog(talk as Parameters<typeof fetchLinejsConversationCatalog>[0], (call) => call()));
  }

  /** `getMessageBoxes [{...}, 2]` page by page (`minChatId` cursor, `hasNext`), as OkLine's chat list does. */
  async #readMessageBoxes(): Promise<{ messageBoxes: readonly { id?: unknown }[] }> {
    const boxes: { id?: unknown }[] = [];
    let minChatId: string | null = null;
    for (let page = 0; page < MESSAGE_BOX_MAX_PAGES; page += 1) {
      const response: unknown = await this.#gateway.call('Talk.TalkService.getMessageBoxes', [{
        minChatId, activeOnly: true, unreadOnly: false, messageBoxCountLimit: MESSAGE_BOX_PAGE_LIMIT, withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 5,
      }, MESSAGE_BOX_SYNC_REASON], { mode: 'read' });
      const record = response !== null && typeof response === 'object' && !Array.isArray(response) ? response as Record<string, unknown> : {};
      const pageBoxes = Array.isArray(record.messageBoxes) ? record.messageBoxes as { id?: unknown }[] : [];
      boxes.push(...pageBoxes);
      const last = pageBoxes.at(-1)?.id;
      if (record.hasNext !== true || typeof last !== 'string' || last === minChatId) break;
      minChatId = last;
    }
    return { messageBoxes: boxes };
  }

  async refreshOwnProfile(): Promise<TransportIdentity> {
    if (this.#revoked || !this.#state.accessToken) throw new Error('LINE profile read is unavailable');
    const identity = await this.#run(this.#readContext(), () => fetchIdentity(this.#gateway, this.#state));
    this.#ownMid = identity.ownMid;
    return this.#normalizeIdentity(identity);
  }

  async sync(cursor: TalkCursorV1Dto): Promise<SyncResult> {
    this.#assertUsable();
    if (cursor.globalRev !== '0' || cursor.individualRev !== '0') throw new ChromeForeignCursorError();
    if (!this.#state.accessToken) throw new Error('LINE sync requires a logged-in account');
    this.#lastCursorRevision = cursor.revision;
    if (this.#reopenOnNextSync) {
      this.#reopenOnNextSync = false;
      if (this.#receiver.state.kind === 'disconnected' || this.#receiver.state.kind === 'stopped') this.#receiver.reopen(cursor.revision);
    }
    return this.#run(this.#readContext(), async () => {
      // Pending catch-up items from an earlier sync go first. They take their room before the live operations are drained.
      const reserved = Math.min(this.#pendingCatchup.length, SYNC_BATCH_LIMIT);
      const drained = await this.#buffer.drain(cursor.revision, {
        waitMs: this.#options.receiveWaitMs ?? DEFAULT_RECEIVE_WAIT_MS, limit: SYNC_BATCH_LIMIT - reserved,
      });
      if (drained.disconnected && drained.operations.length === 0 && !drained.jumped) {
        const state = this.#receiver.state;
        throw new ChromeReceiverDisconnectedError(state.kind === 'disconnected' && state.authRejected, state.kind === 'disconnected' ? state.failures : 0);
      }
      // Contact operations keep the friend cache current without a single extra request (ruling 9). A fullSync jump means
      // operations were skipped, so the cache is dropped and loads again at the next relation check.
      if (drained.jumped) this.#friends.reset();
      this.#friends.observe(drained.operations);
      const built = await buildChromeSyncResult({
        operations: drained.operations, cursorAfter: drained.cursorAfter, decryptor: this.#e2ee,
        ownMid: this.#ownMid, seenConversationIds: this.#seenConversationIds, counters: this.#readReceiptCounters,
      });
      const operations: unknown[] = [...this.#pendingCatchup.slice(0, reserved), ...built.operations];
      this.#pendingCatchup = this.#pendingCatchup.slice(reserved);
      // A read receipt can be the first sighting of a chat whose messages predate login. Recover its recent messages once,
      // without rendering the receipt (linejs-adapter.ts:1117-1132). The worker rejects a batch above 100 operations, so the
      // items that do not fit wait in `#pendingCatchup`. The chat stays seen: only a failed read makes it unseen.
      for (const chatId of built.catchupChatIds.slice(0, CATCHUP_MAX_CHATS)) {
        try {
          const recent = await this.#gateway.call<readonly unknown[]>('Talk.TalkService.getRecentMessagesV2',
            [chatId, CATCHUP_MESSAGES_PER_CHAT], { mode: 'read' });
          const items = await buildCatchupItems(Array.isArray(recent) ? recent.slice(0, CATCHUP_MESSAGES_PER_CHAT) : [], this.#e2ee);
          const room = Math.max(0, SYNC_BATCH_LIMIT - operations.length);
          operations.push(...items.slice(0, room));
          this.#pendingCatchup.push(...items.slice(room));
        } catch (error) {
          this.#seenConversationIds.delete(chatId);
          if (isSessionKickout(error)) throw error;
        }
      }
      return { cursorAfter: built.cursorAfter, operations,
        ...(built.readReceipts === undefined ? {} : { readReceipts: built.readReceipts }) } satisfies SyncResult;
    });
  }

  async history(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string },
    cursor: HistoryCursorV1 | null, limit: number): Promise<readonly unknown[]> {
    this.#assertUsable();
    if (cursor && (cursor.accountId !== this.#options.accountId || cursor.chatType !== conversation.chatType ||
      cursor.chatId !== conversation.chatId)) throw new EffectDeniedError('history cursor conversation mismatch');
    return this.#run(this.#readContext(), async () => {
      const response = cursor === null
        ? await this.#gateway.call<unknown>('Talk.TalkService.getRecentMessagesV2', [conversation.chatId, limit], { mode: 'read' })
        : await this.#gateway.call<unknown>('Talk.TalkService.getPreviousMessagesV2WithRequest', [{
          messageBoxId: conversation.chatId,
          endMessageId: { messageId: cursor.messageId, deliveredTime: toJsonInt(cursor.deliveredTime) },
          messagesCount: limit,
        }, HISTORY_SYNC_REASON], { mode: 'read' });
      if (!Array.isArray(response)) throw new Error('LINE history response is invalid');
      return decryptLinejsHistoryMessages(response, (message) => this.#e2ee.decrypt(message as Parameters<ChromeE2ee['decrypt']>[0]));
    });
  }

  // -- writes (step 6) -------------------------------------------------------------------------------------------------
  // Every write is ONE `gate.run` permit with one physical write. Nothing is retried automatically (ruling 7); the only
  // second attempt is the E2EE renegotiation one (or the code-82 re-seal), which runs in a NEW permit.

  async send(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, text: string,
    replyToMessageId: string | null, lease: ControlLease, manual = false, mentions: readonly OutgoingMention[] = []): Promise<{ messageId: string }> {
    this.#assertCanSend(manual);
    assertConversation(conversation);
    const message = buildTextMessage({ to: conversation.chatId, text, replyToMessageId,
      ...(mentions.length > 0 ? { mention: buildMentionContentMetadata(mentions) } : {}) });
    return this.#sendMessage({ build: () => message, lease, manual, sealRequired: false });
  }

  /**
   * Sealed media send: check that the media flow is V2, encrypt the blob, upload it ONCE to `/r/talk/emi|emf/reqid-<uuid>` (no
   * preview upload), then send the sealed placeholder. A failure before `sendMessage` starts is `MediaUploadFailedError`
   * (nothing was sent); the `sendMessage` outcome is reported exactly like a text send.
   */
  async sendMedia(conversation: { chatType: 'direct' | 'group'; chatId: string },
    media: Readonly<{ kind: 'image' | 'file'; bytes: Buffer; fileName: string }>, lease: ControlLease, manual = false): Promise<{ messageId: string }> {
    this.#assertCanSend(manual);
    const prefix = conversation.chatType === 'direct' ? 'u' : conversation.chatType === 'group' ? 'c' : undefined;
    if (prefix === undefined || !conversation.chatId.startsWith(prefix)) throw new EffectDeniedError('conversation type/MID mismatch');
    if (media.kind !== 'image' && media.kind !== 'file') throw new EffectDeniedError('unsupported media kind');
    // The worker already enforces these caps before it reads the file; this keeps a direct caller inside them too.
    const cap = media.kind === 'image' ? MEDIA_IMAGE_MAX_BYTES : MEDIA_FILE_MAX_BYTES;
    if (media.bytes.length === 0 || media.bytes.length > cap) throw new MediaUploadFailedError('media_size');
    const sid = media.kind === 'image' ? 'emi' : 'emf';
    const scope = this.#gate.openMediaUploadScope(lease, media.kind, manual);
    let uploaded: { oid: string; size: number; encKm: string } | undefined;
    // The step that is running; a failure keeps it so the cause of an upload failure is known. The order of the steps is unchanged.
    let stage: MediaUploadStage = 'e2ee_flow';
    try {
      return await this.#sendMessage({
        lease, manual, sealRequired: true,
        build: () => buildMediaMessage({ to: conversation.chatId, kind: media.kind, sid, oid: uploaded!.oid, fileSize: uploaded!.size,
          encKm: uploaded!.encKm, fileName: media.fileName }),
        prepare: async () => {
          if (!this.#e2ee.isReady()) throw new Error('E2EE keys are not available');
          // A media message that cannot be sealed must not leave: check the flow before any OBS POST (line-cli client.go:641-706).
          const contentType = media.kind === 'image' ? CONTENT_TYPE.IMAGE : CONTENT_TYPE.FILE;
          if (!(await this.#e2ee.mediaFlowIsV2(conversation.chatId, contentType))) throw new MediaUploadFailedError('e2ee_flow');
          stage = 'encrypt';
          const encKm = generateEncKm();
          const blob = encryptBlob(decodeEncKm(encKm), media.bytes);
          const obs = this.#makeObs((request) => this.#gate.approveMediaUpload(scope, request));
          // OBS params follow OkLine's order; the blob name is the Unix millisecond timestamp (line-cli client.go:663-667), so the real file name stays inside the sealed plaintext.
          const params = { ver: '2.0', name: String(this.#options.now?.() ?? Date.now()), type: 'file' } as const;
          stage = 'obs_upload';
          const first = await obs.upload({ path: `talk/${sid}/reqid-${randomUUID()}`, data: blob, params })
            .catch((error: unknown) => { this.#noteObsFailure(error); throw error; });
          if (first.objId === '') throw new Error('OBS object id missing');
          // FILE_SIZE is the plaintext size; the encrypted blob size stays out of the message.
          uploaded = { oid: first.objId, size: media.bytes.length, encKm };
          stage = 'e2ee_message';
        },
        beforeWriteFailure: (error) => {
          if (error instanceof MediaUploadFailedError) return error;
          if (error instanceof EffectDeniedError) return tagMediaStage(error, stage);
          const rejection = decodeChromeServerRejection(error);
          return rejection ? tagMediaStage(rejection, stage) : new MediaUploadFailedError(stage, error);
        },
      });
    } finally { scope.close(); }
  }

  async react(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, messageId: string,
    reaction: Extract<LineWorkerCommand, { type: 'reactMessage' }>['reaction'], lease: ControlLease): Promise<void> {
    if (this.#options.mode !== 'ACTIVE_CONTROL' || this.#revoked) throw new EffectDeniedError('worker mode is read-only');
    assertConversation(conversation);
    assertInt64(messageId);
    await this.#write({ phase: 'CONTROL_SEND', lease }, async () => {
      const reqSeq = this.#state.nextReqSeq(); // allocated, persisted (storage event), then used (ruling 8)
      if (reaction === 'UNDO') {
        await this.#gateway.call('Talk.TalkService.cancelReaction', [buildCancelReactionRequest(reqSeq, messageId)], { mode: 'write' });
      } else {
        await this.#gateway.call('Talk.TalkService.react', [buildReactRequest(reqSeq, messageId, reaction as ReactionName)], { mode: 'write' });
      }
    });
  }

  async unsend(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, messageId: string,
    lease: ControlLease): Promise<void> {
    if ((this.#options.mode !== 'ACTIVE_CONTROL' && this.#options.mode !== 'MONITOR_ONLY') || this.#revoked) {
      throw new EffectDeniedError('worker mode is read-only');
    }
    assertConversation(conversation);
    assertInt64(messageId);
    await this.#write({ phase: 'MANUAL_SEND', lease }, async () => {
      const reqSeq = this.#state.nextReqSeq();
      await this.#gateway.call('Talk.TalkService.unsendMessage', [reqSeq, messageId], { mode: 'write' });
    });
  }

  // -- friends ---------------------------------------------------------------------------------------------------------

  async checkFriendRelation(targetMid: string, lease: ControlLease, signal: RelationCancellation = { aborted: false }): Promise<FriendRelation> {
    return (await this.checkFriendRelationDiagnostic(targetMid, lease, signal)).status;
  }

  /**
   * The contact lists are fetched once per session (`getAllContactIds [4]`, minus `getBlockedContactIds [4]`) and then kept
   * current from the SSE contact operations; a check after the first never reaches the gateway (ruling 9).
   */
  async checkFriendRelationDiagnostic(targetMid: string, lease: ControlLease,
    signal: RelationCancellation = { aborted: false }): Promise<FriendRelationDiagnostic> {
    if (this.#options.mode !== 'ACTIVE_CONTROL' || this.#revoked) return { status: 'unknown', error: 'RELATION_BINDING_REVOKED' };
    const unknown = (error: string): FriendRelationDiagnostic => ({ status: 'unknown', error });
    const interrupted = (): FriendRelationDiagnostic | null =>
      signal.aborted || this.#revoked ? unknown(this.#revoked ? 'RELATION_BINDING_REVOKED' : 'RELATION_CANCELLED') : null;
    try {
      const early = interrupted();
      if (early) return early;
      if (!this.#friends.loaded) {
        const loaders = {
          contactIds: () => this.#gateway.call('Talk.TalkService.getAllContactIds', [CATALOG_SYNC_REASON], { mode: 'read' }),
          blockedContactIds: () => this.#gateway.call('Talk.TalkService.getBlockedContactIds', [CATALOG_SYNC_REASON], { mode: 'read' }),
        };
        // Op 49 during a load makes it stale. Load once more inside the same permit. A second stale load is a failure.
        await this.#run({ phase: 'CONTROL_READ', lease }, async () => {
          try { await this.#friends.ensureLoaded(loaders); }
          catch (error) {
            if (!(error instanceof FriendListStaleError)) throw error;
            await this.#friends.ensureLoaded(loaders);
          }
        });
        const late = interrupted();
        if (late) return late;
      }
      return { status: this.#friends.relation(targetMid), error: null };
    } catch (error) {
      if (this.#revoked) return unknown('RELATION_BINDING_REVOKED');
      if (signal.aborted) return unknown('RELATION_CANCELLED');
      return unknown(error instanceof FriendListShapeError ? 'RELATION_LIST_SHAPE_INVALID' : 'RELATION_LIST_RPC_FAILED');
    }
  }

  async addFriendByMid(targetMid: string, lease: ControlLease, onPhysicalStart: () => void,
    signal: RelationCancellation = { aborted: false }, sourceChatMid?: string): Promise<FriendAddResult> {
    if (this.#options.mode !== 'ACTIVE_CONTROL' || this.#revoked || this.#activeRelationAdd) {
      return { status: 'failed', error: 'SIDE_EFFECT_DENIED' };
    }
    const state = { consumed: false, signal, onPhysicalStart };
    this.#activeRelationAdd = state;
    try {
      await this.#run({ phase: 'CONTROL_SEND', lease }, async () => {
        if (signal.aborted || this.#revoked || this.#options.mode !== 'ACTIVE_CONTROL') {
          throw new EffectDeniedError('Relation add cancelled before the gateway call');
        }
        const reqSeq = this.#state.nextReqSeq();
        await this.#gateway.call('Relation.RelationService.addFriendByMid', [buildAddFriendRequest(reqSeq, targetMid, sourceChatMid)], { mode: 'write' });
      });
      return { status: 'added', error: null };
    } catch (error) {
      if (!state.consumed) return { status: 'failed', error: error instanceof EffectDeniedError ? 'SIDE_EFFECT_DENIED' : 'NOT_STARTED' };
      const rejection = decodeChromeFriendAddRejection(error);
      return rejection ? { status: 'failed', error: rejection } : { status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' };
    } finally { this.#activeRelationAdd = undefined; }
  }

  // -- download --------------------------------------------------------------------------------------------------------

  async download(_kind: 'image' | 'video' | 'audio' | 'file', _messageId: string, _externalAttachmentId: string,
    lineMessage: JsonValue, options: Readonly<{ signal: AbortSignal; maxBytes: number; identity: AttachmentDownloadIdentity;
      nativeAttachment?: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>['nativeAttachment'] }>): Promise<DownloadedAttachment> {
    if (this.#revoked || !this.#state.accessToken) throw new EffectDeniedError('OBS download requires login');
    const context = this.#readContext();
    try {
      return await this.#run(context, async () => {
        if (options.signal.aborted) throw options.signal.reason;
        const native = options.nativeAttachment;
        const nativeParsed = native ? validateNativeAttachment(native, options.identity, options.maxBytes) : null;
        const parsed = nativeParsed ?? validateAttachmentMessage(lineMessage, options.identity, options.maxBytes);
        let keyMaterial: Buffer | null = nativeParsed?.keyMaterial ?? null;
        let name: string | null = nativeParsed?.fileName ?? null;
        let sealedKeyText: unknown;
        if (parsed.encrypted && !native) {
          // The sealed chunks carry ENC_KM / FILE_NAME; decrypting them is the only way to learn the file key.
          let decrypted: ChromeMessage;
          try { decrypted = await this.#e2ee.decrypt(parsed.message); }
          catch (error) { throw attachmentPhaseFailure(error, 'LINE_E2EE_METADATA_RPC_FAILED', 'LINE_E2EE_METADATA_DECRYPT_FAILED'); }
          const metadata = decrypted.contentMetadata !== null && typeof decrypted.contentMetadata === 'object'
            ? decrypted.contentMetadata as Record<string, unknown> : {};
          const encKm = metadata.ENC_KM;
          // OkLine e2ee.py:378-385: only a Python-falsy ENC_KM fails before the OBS GET. The key text is decoded after the GET (:393-394).
          if (!pythonTruthy(encKm)) throw new SafeAttachmentError('LINE_E2EE_KEY_MISMATCH');
          sealedKeyText = encKm;
          if (typeof metadata.FILE_NAME === 'string' && metadata.FILE_NAME.length <= 255) name = metadata.FILE_NAME;
        }
        const obs = this.#makeObs((request) => this.#gate.approveObsDownload(context, request));
        const ciphertext = await obs.download({
          sid: parsed.sid, oid: parsed.oid, ...(parsed.tid ? { suffix: '/original' } : {}),
          ...(parsed.encrypted ? { talkMessageId: options.identity.messageId } : {}),
          pop: parsed.obsPop, maxBytes: options.maxBytes + (parsed.encrypted ? 32 : 0), signal: options.signal,
        });
        if (sealedKeyText !== undefined) {
          // OkLine e2ee.py:394 runs after the GET: a non-string raises TypeError there, a bad text raises ValueError there.
          try {
            if (typeof sealedKeyText !== 'string') throw new TypeError('ENC_KM is not a string');
            keyMaterial = decodeEncKm(sealedKeyText);
          } catch {
            throw new SafeAttachmentError('LINE_E2EE_KEY_MISMATCH');
          }
        }
        let output: Buffer = ciphertext;
        if (keyMaterial) {
          // OkLine decrypts every sealed kind with the one HKDF + AES-CTR + HMAC blob format (e2ee.py:365-399).
          try { output = decryptBlob(keyMaterial, ciphertext); }
          catch { throw new SafeAttachmentError('LINE_MEDIA_AUTH_FAILED'); }
        }
        if (output.length > options.maxBytes) throw new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
        return { name, source: singleChunk(output) };
      });
    } catch (error) {
      this.#noteObsFailure(error);
      if (options.signal.aborted) {
        const reason = options.signal.reason as { code?: unknown } | undefined;
        throw new SafeAttachmentError(reason?.code === 'TIMEOUT' ? 'LINE_DOWNLOAD_TIMEOUT' : 'LINE_DOWNLOAD_CANCELLED');
      }
      throw classifyChromeAttachmentFailure(error);
    }
  }

  // -- chat resources -----------------------------------------------------------------------------------------------------

  /**
   * The only reference with album code is line-cli, and it has one album call: the photo download (`DownloadAlbumPreview`,
   * the 482 px rendition of an `album/a` object). So notes, the album list, the photo list and video (`album/v`) downloads
   * are unsupported here; none of them has an endpoint to port and none is guessed.
   */
  async readChatResource(command: ChatResourceReadCommand, options: Readonly<{ signal: AbortSignal }>): Promise<{
    notes?: readonly unknown[]; note?: unknown; albums?: readonly unknown[]; nextCursor?: string | null;
    photos?: readonly unknown[]; bytes?: Uint8Array;
  }> {
    if (command.action !== 'downloadAlbumPhoto' || command.prefix !== 'album/a') throw new ChatResourceUnsupportedError();
    this.#assertUsable();
    if (!this.#state.accessToken) throw new EffectDeniedError('chat resources require a logged-in account');
    assertConversation(command);
    if (options.signal.aborted) throw options.signal.reason;
    const context = this.#readContext();
    return await this.#run(context, async () => {
      let channelToken: string;
      try { channelToken = await this.#channelTokens.get(ALBUM_CHANNEL_ID, options.signal); }
      catch (error) {
        if (options.signal.aborted || isSessionKickout(error) || error instanceof EffectDeniedError) throw error;
        throw chatResourceFailure('bootstrap_failure', error instanceof ChannelTokenError ? undefined : error);
      }
      // Read the token after the channel token wait: a refresh may have replaced it. An empty value omits the header.
      const accessToken = this.#state.accessToken ?? '';
      let bytes: Buffer;
      try {
        bytes = await downloadAlbumPreview({
          fetch: this.#fetch, channelToken, accessToken, chatId: command.chatId, albumId: command.albumId!, oid: command.oid!,
          maxBytes: command.maxBytes!, signal: options.signal,
          authorize: (request) => this.#gate.approveAlbumPhotoDownload(context, request),
        });
      } catch (error) {
        if (options.signal.aborted || isSessionKickout(error) || error instanceof EffectDeniedError) throw error;
        throw chatResourceFailure(error instanceof ObsSizeLimitError ? 'response_validation' : 'list_get_transport_failure', error);
      }
      if (options.signal.aborted) throw options.signal.reason;
      return { bytes };
    });
  }

  // -- lifecycle -------------------------------------------------------------------------------------------------------

  /**
   * Stops the event stream and the refresh timer for good (the worker calls this on revoke, stop and auth invalidation).
   * A revoked adapter does not sync again; a new worker takes over.
   */
  revoke(): void {
    this.#revoked = true;
    this.#channelTokens.clear();
    this.#obsToken = undefined;
    this.#refresher.stop();
    this.#receiver.stop();
  }

  /**
   * Manual reconnect of a terminally disconnected event stream (it never restarts by itself after 144 failed attempts).
   * The next `sync` reopens it at the durable cursor; a login does the same. Returns false when the adapter is revoked or
   * logged out.
   */
  reconnectReceiver(): boolean {
    if (this.#revoked || this.#serverLogoutStarted || !this.#state.accessToken) return false;
    this.#reopenOnNextSync = true;
    return true;
  }

  /** Releases the ltsm sandbox. Not called by the worker (the process exits); tests and embedders use it. */
  dispose(): void {
    this.revoke();
    this.#closeable?.close();
  }

  // -- internals -------------------------------------------------------------------------------------------------------

  #newE2ee(): ChromeE2ee {
    const parts = { bridge: this.#bridge, api: new GatewayE2eeKeyApi(this.#gateway), store: this.#state,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }) };
    return this.#options.createE2ee === undefined ? new ChromeE2ee(parts) : this.#options.createE2ee(parts);
  }

  #assertCanSend(manual: boolean): void {
    if ((this.#options.mode !== 'ACTIVE_CONTROL' && !(manual && this.#options.mode === 'MONITOR_ONLY')) || this.#revoked) {
      throw new EffectDeniedError('worker mode is read-only');
    }
  }

  /** A write permit with the server's TalkException rejections projected to the worker's `LineServerRejection`. */
  async #write<T>(context: ChromeEffectContext, fn: () => Promise<T>): Promise<T> {
    try { return await this.#run(context, fn); }
    catch (error) { throw decodeChromeServerRejection(error) ?? error; }
  }

  #makeObs(authorize: ConstructorParameters<typeof ObsClient>[0]['authorize']): ObsClient {
    return new ObsClient({ fetch: this.#fetch, authorize, acquireToken: (signal) => this.#obsTokenFor(signal) });
  }

  /** The session token. A failed request is not cached. */
  #obsTokenFor(signal?: AbortSignal): Promise<string> {
    if (this.#obsToken !== undefined) return this.#obsToken;
    const pending = this.#acquireObsToken(signal);
    this.#obsToken = pending;
    pending.catch(() => { if (this.#obsToken === pending) this.#obsToken = undefined; });
    return pending;
  }

  /** An OBS answer of 401 or 403 means the token is no longer valid: forget it. The request is not retried. */
  #noteObsFailure(error: unknown): void {
    if (error instanceof ObsHttpError && (error.status === 401 || error.status === 403)) this.#obsToken = undefined;
  }

  /** `acquireEncryptedAccessToken [2]` (OBS_GENERAL): the caller caches the result for the session (`#obsTokenFor`). */
  async #acquireObsToken(signal?: AbortSignal): Promise<string> {
    let raw: unknown;
    try {
      raw = await this.#gateway.call('Talk.TalkService.acquireEncryptedAccessToken', [OBS_GENERAL_FEATURE],
        { mode: 'read', ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (isSessionKickout(error) || error instanceof EffectDeniedError) throw error;
      const rejection = decodeChromeServerRejection(error);
      throw rejection ? new SafeAttachmentError('LINE_OBS_TOKEN_RPC_FAILED', rejection.code, rejection.upstreamCode)
        : new SafeAttachmentError('LINE_OBS_TOKEN_RPC_FAILED');
    }
    const token = parseEncryptedAccessToken(raw);
    if (token === null) throw new SafeAttachmentError('LINE_OBS_TOKEN_INVALID');
    return token;
  }

  /**
   * Seals the message when the E2EE keys are loaded (OkLine `encrypt`; the extension seals up front, so a plain send that
   * the server answers with 82 only happens when sealing was declined). A media message must never leave unsealed: its
   * key material would travel in clear metadata.
   */
  async #seal(message: ChromeMessage, required: boolean, options: { mediaFlowChecked?: boolean } = {}): Promise<{ outgoing: ChromeMessage; sealed: boolean }> {
    if (!this.#e2ee.isReady()) {
      if (required) throw new Error('E2EE keys are not available');
      return { outgoing: message, sealed: false };
    }
    const outgoing = await this.#e2ee.encrypt(message, options);
    const sealed = Array.isArray(outgoing.chunks) && outgoing.chunks.length > 0;
    if (required && !sealed) throw new Error('E2EE sealing was declined for a media message');
    return { outgoing, sealed };
  }

  /**
   * One logical send. Attempt 0 runs `prepare` (media upload), seals and writes under one permit. A second attempt happens only
   * for the E2EE recovery cases (84/86/87/88/90, 99, and 82 on an unsealed send), in a NEW permit, after the recovery. Any
   * other failure, and every transport-level one, ends the send; the loop reports it as unknown or rejected.
   */
  async #sendMessage(args: Readonly<{
    build: () => ChromeMessage; lease: ControlLease; manual: boolean; sealRequired: boolean;
    prepare?: () => Promise<void>;
    /** Maps a failure that happened before `sendMessage` was attempted. Default: the plain write-error projection. */
    beforeWriteFailure?: (error: unknown) => unknown;
  }>): Promise<{ messageId: string }> {
    const context = { phase: args.manual ? 'MANUAL_SEND' : 'CONTROL_SEND', lease: args.lease } as const;
    let previous: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let written = false;
      let sealed = false;
      let message: ChromeMessage | undefined;
      try {
        const response = await this.#run(context, async () => {
          if (attempt === 0) await args.prepare?.();
          else await this.#recoverForRetry(args.build(), previous);
          message = args.build();
          // Attempt 0 ran `prepare`, which checked the media flow already. Attempt 1 runs no `prepare`, so the seal checks once.
          const prepared = await this.#seal(message, args.sealRequired, { mediaFlowChecked: attempt === 0 && args.sealRequired });
          sealed = prepared.sealed;
          const reqSeq = this.#state.nextReqSeq(); // allocate + persist before the value is used on the wire
          written = true; // from here on the outcome of the physical write is not known to be "nothing sent"
          return await this.#gateway.call<unknown>('Talk.TalkService.sendMessage', [reqSeq, prepared.outgoing], { mode: 'write' });
        });
        return { messageId: messageIdOf(response) };
      } catch (error) {
        if (!written) {
          const mapped = args.beforeWriteFailure?.(error);
          throw mapped !== undefined ? mapped : decodeChromeServerRejection(error) ?? error;
        }
        const built = message ?? args.build();
        if (attempt === 0 && this.#canRetrySend(error, built, sealed)) { previous = error; continue; }
        // The send ends here. For an E2EE error the cached state of the chat is stale, so reset all of it (OkLine e2ee.py:692-709).
        // The group key is not registered again on a final failure.
        const kind = classifyE2eeSendError(error).kind;
        if (kind === 'renegotiate' || kind === 'recreate-group-key' || kind === 'refresh-media-flow') {
          this.#e2ee.resetNegotiation(typeof built.to === 'string' ? built.to : '');
        }
        throw decodeChromeServerRejection(error) ?? error;
      }
    }
    throw new Error('LINE send ended without a result');
  }

  #canRetrySend(error: unknown, message: ChromeMessage, wasSealed: boolean): boolean {
    if (!(error instanceof ChromeApiError)) return false;
    const classification = classifyE2eeSendError(error);
    if (isRetryableE2eeSendError(classification)) return true;
    // 82: the server wants this content sealed (OkLine messaging.py:46-58). Worth one retry only if sealing is possible now.
    return classification.code === E2EE_ERROR_CODE.RETRY_ENCRYPT && !wasSealed && this.#e2ee.isReady()
      && SEALABLE_CONTENT_TYPES.has(Number(message.contentType));
  }

  /** Runs inside the retry's own permit: resets the chat's E2EE state (and re-registers a group key for 99). */
  async #recoverForRetry(message: ChromeMessage, previous: unknown): Promise<void> {
    await this.#e2ee.recoverFromSendError(message, previous);
  }

  #markStreamForReopen(): void {
    if (this.#receiver.state.kind === 'disconnected' || this.#receiver.state.kind === 'stopped') this.#reopenOnNextSync = true;
  }

  #assertUsable(): void {
    if (this.#revoked) throw new EffectDeniedError('transport is revoked');
  }

  #readContext(): { phase: 'CONTROL_READ'; lease: ControlLease } | { phase: 'MONITOR_READ' } {
    return this.#options.mode === 'ACTIVE_CONTROL' && !this.#revoked
      ? { phase: 'CONTROL_READ', lease: { accountId: this.#options.accountId, workerInstanceId: this.#options.workerInstanceId,
        controlEpoch: this.#options.controlEpoch } }
      : { phase: 'MONITOR_READ' };
  }

  /** Runs one worker operation inside its permit; a dead session surfaces as `authInvalidated`, like the DESKTOPWIN adapter. */
  async #run<T>(context: ChromeEffectContext, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.#gate.run(context, fn);
    } catch (error) {
      if (isSessionKickout(error) && !this.#revoked) {
        this.#refresher.stop();
        this.#receiver.stop();
        this.#state.emit('authInvalidated');
      }
      throw error;
    }
  }

  #normalizeIdentity(identity: ChromeIdentity): TransportIdentity {
    const picturePath = Object.hasOwn(identity, 'picturePath') ? normalizeLinePicturePath(identity.picturePath, true) : undefined;
    return { ownMid: identity.ownMid, displayName: identity.displayName, ...(picturePath === undefined ? {} : { picturePath }) };
  }
}

/**
 * Builds the adapter. Without injected `signer` and `bridge` it loads the pinned ltsm assets from `ltsmRoot`; when they
 * are absent, wrong-version or corrupt it throws `ChromeLtsmUnavailableError` (the worker reports it as
 * `CHROME_LTSM_UNAVAILABLE` plus the store status instead of crashing).
 */
export async function createChromeAdapter(options: ChromeAdapterOptions): Promise<ChromeAdapter> {
  if (options.signer !== undefined && options.bridge !== undefined) {
    return new ChromeAdapter(options, { signer: options.signer, bridge: options.bridge });
  }
  if (options.ltsmRoot === undefined) {
    throw new ChromeLtsmUnavailableError({ kind: 'missing', required: requiredLtsmPin().version });
  }
  const store = new LtsmStore({ rootDir: options.ltsmRoot });
  let bridge: LtsmBridge;
  try {
    const assets = await store.load();
    bridge = await LtsmBridge.create({ sandboxSource: assets.sandbox, wasm: assets.wasm });
  } catch (error) {
    if (error instanceof LtsmUnavailableError) {
      const status = error.status;
      if (status.kind !== 'available') throw new ChromeLtsmUnavailableError(status);
    }
    // Verified assets that still fail to start are unusable for the same reason a corrupt copy is.
    throw new ChromeLtsmUnavailableError({ kind: 'corrupt', required: CHROME_EXTENSION_VERSION });
  }
  const signer = new LtsmHmacSigner(bridge);
  return new ChromeAdapter(options, { signer: options.signer ?? signer, bridge: options.bridge ?? bridge, closeable: signer });
}
