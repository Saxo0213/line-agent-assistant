// LINE transport on the linejs Client (phase 1). Every LINE call is a linejs call.
// This file only connects linejs to the LineTransport interface. It sets no argument, header, timer, retry or request
// that linejs does not set in the same flow. The linejs CLI file and line that each method follows is named at the method.
import { InternalError } from '@evex/linejs/base';
import type { Chat, Client } from '@evex/linejs';
import {
  buildMentionContentMetadata, normalizeNativePicturePath, type AccountMode, type ChatResourceReadCommand, type ConversationCatalogItem,
  type JsonValue, type LinejsTransportKind, type OutgoingMention, type TalkCursorV1Dto,
} from '@line-agent/contracts';
import type { HistoryCursorV1 } from './cursor.js';
import { EffectDeniedError, type ControlLease } from './mutation-gate.js';
import { safeRaw } from './normalizer.js';
import { SafeAttachmentError } from './attachment-error.js';
import { validateAttachmentMessage } from './attachment-download.js';
import { safeChatResourceFailureDetails } from './chat-resource-error.js';
import { authInvalidationDetailOfName, decodeLinejsServerRejection, decodeSquareRejection, isTalkAuthInvalidation,
  talkAuthInvalidationDetail, type AuthInvalidationDetail } from './line-server-error.js';
import { classifyLinejsFailure, hasLinejsMethodTag, tagLinejsFailure } from './login-failure-detail.js';
import type { FriendAddResult, FriendRelation, FriendRelationDiagnostic, LineTransport, RelationCancellation,
  SquareSyncResult, SyncItem, SyncResult, TransportIdentity } from './worker-loop.js';
import { ObservedMemoryStorage } from './linejs-client-engine-storage.js';
import { OperationCollector, decimal } from './linejs-client-engine-ops.js';
import { readLinejsChatResource, type ChatResourceValue } from './linejs-client-engine-resources.js';
import { LinejsFullClient, type LinejsFetchOption } from './linejs-client-full.js';

type EventName = 'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated' | 'refreshFailure';
type Conversation = { chatType: 'direct' | 'group' | 'room'; chatId: string };
type FetchOption = LinejsFetchOption;

export type LinejsClientEngineOptions = Readonly<ControlLease & {
  mode: AccountMode;
  /** The linejs device. Absent means DESKTOPWIN. */
  device?: LinejsTransportKind;
  /** A custom linejs fetch. Production leaves it absent so that linejs uses its own default fetch. Tests give a mock. */
  fetch?: FetchOption;
  /** True turns on LEGY encryption, Absent or false means off. */
  legyEncrypted?: boolean;
  /** Longest local wait of one `sync` or `syncSquare` call, in milliseconds. Absent means the linejs push ping interval. */
  syncWaitMs?: number;
}>;

type TalkEntry = { op: Record<string, unknown>; state: 'pending' | 'ready' | 'failed' };

/** Operation types whose message the linejs listener decrypts in place (client/client.ts listen). */
const DECRYPTED_TYPES = new Set(['SEND_MESSAGE', 'RECEIVE_MESSAGE', 'NOTIFIED_EDIT_MESSAGE', 'EDIT_MESSAGE']);
const AUTH_DEAD_CODES = new Set(['NOT_AUTHORIZED_DEVICE', 'V3_TOKEN_CLIENT_LOGGED_OUT', 'AUTHENTICATION_FAILED', 'NOT_AVAILABLE_USER']);
const REFRESH_PATH = '/EXT/auth/tokenrefresh/v1';
const REQUEST_ERROR_NAME = /^Request internal failed, ([A-Za-z0-9_]{1,64})\((\/[A-Za-z0-9_/]{1,64})\) -> /;
const INT64_MAX = 9223372036854775807n;
/** The most operations that one `sync` call returns: the bounded batch limit of the worker loop. */
const MAX_BATCH = 100;
const MID_PREFIX = { direct: 'u', group: 'c', room: 'r' } as const;

function ownData(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof InternalError) || error.type !== 'RequestError') return null;
  const data = error.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}
function ownCode(data: Record<string, unknown> | null): unknown {
  if (!data) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(data, 'code');
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function requestName(error: unknown): { method: string; path: string } | null {
  if (!(error instanceof InternalError) || error.type !== 'RequestError') return null;
  const match = REQUEST_ERROR_NAME.exec(error.message);
  return match ? { method: match[1]!, path: match[2]! } : null;
}
function stringIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (value && typeof value === 'object') return Object.keys(value).filter((item) => item.length > 0);
  return [];
}
function picturePath(value: unknown, present: boolean): string | null | undefined {
  if (!present) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || (!value.startsWith('/') && !value.startsWith('https://'))) return undefined;
  return normalizeNativePicturePath(value) ?? undefined;
}
function chatKind(chatId: string): 'direct' | 'group' | 'room' | null {
  return chatId.startsWith('u') ? 'direct' : chatId.startsWith('c') ? 'group' : chatId.startsWith('r') ? 'room' : null;
}
function int64(value: string): boolean { return /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= INT64_MAX; }
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error('LINE request aborted'));
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
}

type UserInfo = { displayName: string | null; nickname?: string; picturePath?: string | null; friend?: boolean };

export class LinejsClientEngine implements LineTransport {
  readonly #options: LinejsClientEngineOptions;
  readonly #full: LinejsFullClient;
  readonly #client: Client;
  readonly #storage = new ObservedMemoryStorage();
  readonly #listeners: Partial<Record<EventName, (value?: any) => void>> = {};
  readonly #listenAbort = new AbortController();
  readonly #waiters = new Set<() => void>();
  readonly #collector = new OperationCollector(() => this.#full.profile?.mid);
  readonly #users = new Map<string, UserInfo>();
  #talkQueue: TalkEntry[] = [];
  #squareQueue: unknown[] = [];
  #talkStarted = false;
  #squareStarted = false;
  #streamError: unknown;
  #restartTalk = false;
  #revoked = false;
  #authDeadEmitted = false;
  #lastMethod: string | undefined;
  #lastCursor: TalkCursorV1Dto | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshGeneration = 0;
  #refreshActive = true;
  #refreshInFlight: Promise<void> | undefined;
  #logoutStarted = false;

  constructor(options: LinejsClientEngineOptions) {
    this.#options = options;
    // linejs default options. Only the device, the storage, the LEGY setting and (tests) a custom fetch are given.
    const full = new LinejsFullClient({ device: options.device ?? 'DESKTOPWIN', storage: this.#storage,
      ...(options.legyEncrypted === true ? { legyEncrypted: true } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.#full = full;
    this.#client = full.client;
    full.onQrCall((code) => this.#listeners.qr?.(code));
    full.onPinCall((pin) => this.#listeners.pin?.(pin));
    full.onAuthToken((token) => this.#listeners.token?.(token));
    full.onQrCert((qrCert) => this.#listeners.qrCert?.(qrCert));
    full.onLog((entry) => this.#onLog(entry));
    this.#storage.setListener((change) => {
      this.#listeners.storage?.(safeRaw(this.#storage.getAll()));
      // linejs writes `expire` last when it issues or refreshes a V3 token.
      const token = full.authToken;
      if (change.key === 'expire' && typeof token === 'string') {
        this.#listeners.credentials?.({ token, e2eeStorage: safeRaw(this.#storage.getAll()) });
      }
      void this.#scheduleTokenRefresh();
    });
    this.#client.on('event', (op) => this.#onEvent(op as unknown as Record<string, unknown>));
    this.#client.on('message', (message) => this.#onMessage(message.raw));
    this.#client.on('message:edit', (message) => this.#onMessage(message.raw));
    this.#client.on('square:event', (event) => { this.#squareQueue.push(event); this.#poke(); });
  }

  on(event: EventName, listener: (value?: any) => void): void { this.#listeners[event] = listener; }

  // ---- observation of linejs events (no request is made or changed) ----

  #onLog(entry: { type: string; data: any }): void {
    try {
      const data = entry.data;
      if (entry.type === 'request' && typeof data?.methodName === 'string') this.#lastMethod = data.methodName;
      else if (entry.type === 'LegyPusherError' || entry.type === 'LegyPusherError_cannot_init') {
        const pending = this.#talkQueue.filter((item) => item.state === 'pending');
        if (pending.length > 0 && entry.type === 'LegyPusherError') for (const item of pending) item.state = 'failed';
        else {
          this.#streamError = data?.error ?? new Error('LINE push stream failed');
          this.#restartTalk = !this.#full.isListening;
          this.#observeAuth(this.#streamError, '/SYNC4', 'sync');
        }
        this.#poke();
      } else if (entry.type === '[LEGY/PUSH] sync error:' && data && typeof data === 'object') {
        const code = (data as Record<string, unknown>).code;
        if (typeof code === 'string' && AUTH_DEAD_CODES.has(code)) this.#emitAuthInvalidated(authInvalidationDetailOfName(code));
      }
    } catch { /* A log observer never throws into linejs. */ }
  }

  #onEvent(op: Record<string, unknown>): void {
    try {
      // The linejs listener handles one operation at a time. A message that is still pending now has failed to decrypt.
      for (const item of this.#talkQueue) if (item.state === 'pending') item.state = 'failed';
      const decrypted = op.message !== undefined && op.message !== null && DECRYPTED_TYPES.has(String(op.type));
      this.#talkQueue.push({ op, state: decrypted ? 'pending' : 'ready' });
      this.#poke();
    } catch { /* see #onLog */ }
  }

  #onMessage(raw: unknown): void {
    try {
      const entry = this.#talkQueue.find((item) => item.state === 'pending' && item.op.message === raw);
      if (entry) { entry.state = 'ready'; this.#poke(); }
    } catch { /* see #onLog */ }
  }

  #poke(): void { for (const waiter of [...this.#waiters]) waiter(); }

  async #waitUntil(ready: () => boolean): Promise<void> {
    if (ready()) return;
    const ms = this.#options.syncWaitMs ?? this.#full.pushPingIntervalMs;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.#waiters.delete(check); resolve(); };
      const check = () => { if (ready()) finish(); };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.#waiters.add(check);
    });
  }

  // ---- errors ----

  #emitAuthInvalidated(detail: AuthInvalidationDetail | undefined): void {
    if (this.#authDeadEmitted) return;
    this.#authDeadEmitted = true;
    this.#cancelTokenRefresh(true);
    this.#listeners.authInvalidated?.(detail);
  }

  // ---- token refresh ----
  // linejs refreshes a token only after the server answers MUST_REFRESH_V3_TOKEN (base/request/mod.ts:219-245). It has no timer.
  // The timer and the refresh before login: refresh when `expire` (stored by linejs) has passed.

  #cancelTokenRefresh(deactivate = false): void {
    if (deactivate) this.#refreshActive = false;
    this.#refreshGeneration += 1;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  async #scheduleTokenRefresh(): Promise<void> {
    if (!this.#refreshActive || this.#revoked) return;
    const generation = ++this.#refreshGeneration;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    if (this.#logoutStarted) return;
    try {
      const [expire, refreshToken] = await Promise.all([this.#storage.get('expire'), this.#storage.get('refreshToken')]);
      if (!this.#refreshActive || this.#revoked || generation !== this.#refreshGeneration || this.#logoutStarted
        || typeof expire !== 'number' || !Number.isFinite(expire) || typeof refreshToken !== 'string' || !refreshToken) return;
      const delayMs = Math.max(0, expire * 1000 - Date.now() - Math.random() * 1000);
      this.#refreshTimer = setTimeout(() => {
        if (!this.#refreshActive || this.#revoked || generation !== this.#refreshGeneration || this.#logoutStarted) return;
        this.#refreshTimer = undefined;
        void this.#refreshNow(generation);
      }, Math.min(delayMs, 2_147_000_000));
      this.#refreshTimer.unref?.();
    } catch { /* Missing or unreadable stored auth does not invalidate a usable session. */ }
  }

  async #refreshNow(generation: number): Promise<void> {
    const run = (async () => {
      try {
        await this.#linejs(() => this.#full.tryRefreshToken());
      } catch {
        // A dead token already emitted `authInvalidated` (through `#observeAuth`) and stopped the schedule.
        if (this.#refreshActive && !this.#revoked) this.#listeners.refreshFailure?.({ code: 'LINE_TOKEN_REFRESH_FAILED' });
        return;
      }
      // The new `expire` also reaches the storage listener. This call makes sure that the next timer starts once.
      if (this.#refreshActive && !this.#revoked && generation === this.#refreshGeneration) void this.#scheduleTokenRefresh();
    })();
    this.#refreshInFlight = run;
    try { await run; } finally { if (this.#refreshInFlight === run) this.#refreshInFlight = undefined; }
  }

  /** Emit `authInvalidated` when linejs reports a dead token: the pinned Talk codes, NOT_AUTHORIZED_DEVICE, V3_TOKEN_CLIENT_LOGGED_OUT or a failed refresh. */
  #observeAuth(error: unknown, path: string, method: string): void {
    if (this.#authDeadEmitted) return;
    if (isTalkAuthInvalidation(error, path, method, 4)) {
      this.#emitAuthInvalidated(talkAuthInvalidationDetail(error, path, method, 4));
      return;
    }
    const data = ownData(error);
    if (!data) return;
    const code = ownCode(data);
    if (typeof code === 'string' && (code === 'NOT_AUTHORIZED_DEVICE' || code === 'V3_TOKEN_CLIENT_LOGGED_OUT')) {
      this.#emitAuthInvalidated(authInvalidationDetailOfName(code));
    } else if (requestName(error)?.path === REFRESH_PATH) {
      this.#emitAuthInvalidated(authInvalidationDetailOfName(code));
    }
  }

  #translate(error: unknown, squareMethod?: string): unknown {
    const named = requestName(error);
    const path = named?.path ?? '/S4';
    const method = named?.method ?? '';
    this.#observeAuth(error, path, method);
    const rejection = decodeLinejsServerRejection(error, path, method, 4);
    if (rejection) return rejection;
    if (squareMethod) {
      const square = decodeSquareRejection(error, squareMethod);
      if (square) return square;
    }
    if (!(error instanceof InternalError) && !(error instanceof EffectDeniedError) && !hasLinejsMethodTag(error)) {
      tagLinejsFailure(error, { ...(this.#lastMethod ? { method: this.#lastMethod } : {}), kind: classifyLinejsFailure(error) });
    }
    return error;
  }

  async #linejs<T>(call: () => Promise<T>, squareMethod?: string): Promise<T> {
    try { return await call(); } catch (error) { throw this.#translate(error, squareMethod); }
  }

  /**
   * The write rule: ACTIVE_CONTROL allows every write. MONITOR_ONLY allows only a manual send, a manual media send
   * and an unsend (`monitorManual`). PAUSED and a revoked worker allow none. The lease must match this worker.
   */
  #requireWrite(lease: ControlLease, monitorManual = false): void {
    if (this.#revoked || (this.#options.mode !== 'ACTIVE_CONTROL' && !(monitorManual && this.#options.mode === 'MONITOR_ONLY'))) {
      throw new EffectDeniedError('worker mode is read-only');
    }
    if (lease.accountId !== this.#options.accountId || lease.workerInstanceId !== this.#options.workerInstanceId
      || lease.controlEpoch !== this.#options.controlEpoch) throw new EffectDeniedError('control lease does not match this worker');
  }

  #requireConversation(conversation: Conversation): void {
    if (!conversation.chatId.startsWith(MID_PREFIX[conversation.chatType])) throw new EffectDeniedError('conversation type/MID mismatch');
  }

  // ---- login ----

  async installSecrets(secrets: { token: string | null; qrCert: string | null; e2eeStorage: JsonValue | null }): Promise<void> {
    await this.#storage.load(secrets.e2eeStorage, secrets.qrCert);
    if (secrets.token === null) this.#full.clearAuthToken();
    else this.#full.setAuthToken(secrets.token);
    await this.#scheduleTokenRefresh();
  }

  #identity(): TransportIdentity {
    const profile = this.#full.profile;
    if (!profile?.mid) throw new Error('LINEJS login returned no profile MID');
    const raw = profile as typeof profile & { picturePath?: unknown };
    const path = picturePath(raw.picturePath, Object.hasOwn(raw, 'picturePath'));
    return { ownMid: profile.mid, displayName: profile.displayName ?? null, ...(path === undefined ? {} : { picturePath: path }) };
  }

  /** `LinejsFullClient.loginWithQr`: the flow of loginWithQR in client/login.ts. */
  async loginQr(): Promise<TransportIdentity> {
    await this.#linejs(() => this.#full.loginWithQr());
    await this.#scheduleTokenRefresh();
    return this.#identity();
  }

  /**
   * `LinejsFullClient.loginWithToken`: the same steps as loginWithAuthToken in client/login.ts, then `ready()`.
   * An expired token is refreshed first with `LinejsFullClient.tryRefreshToken` (linejs `tryRefreshToken`).
   */
  async loginToken(token: string): Promise<TransportIdentity> {
    let tokenToUse = token;
    const expire = await this.#storage.get('expire');
    const refreshToken = await this.#storage.get('refreshToken');
    if (typeof expire === 'number' && Number.isFinite(expire) && expire <= Math.floor(Date.now() / 1000) && typeof refreshToken === 'string') {
      await this.#linejs(() => this.#full.tryRefreshToken());
      const refreshed = this.#full.authToken;
      if (!refreshed) throw new Error('LINEJS refresh returned no access token');
      tokenToUse = refreshed;
    }
    await this.#linejs(() => this.#full.loginWithToken(tokenToUse));
    await this.#scheduleTokenRefresh();
    return this.#identity();
  }

  /** `LinejsFullClient.logout` (linejs `logoutZ`). The refresh timer pauses while the logout runs. */
  async logoutServer(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('LINE server logout aborted');
    this.#logoutStarted = true;
    this.#cancelTokenRefresh();
    try {
      const inFlight = this.#refreshInFlight;
      if (inFlight) await Promise.race([inFlight.catch(() => undefined), aborted(signal)]);
      await Promise.race([this.#full.logout(), aborted(signal)]);
    } catch (error) {
      const code = ownCode(ownData(error));
      if (typeof code === 'string' && AUTH_DEAD_CODES.has(code)) {
        this.#emitAuthInvalidated(authInvalidationDetailOfName(code));
        this.#cancelTokenRefresh(true);
        this.#listenAbort.abort();
        return;
      }
      this.#logoutStarted = false;
      if (!this.#refreshInFlight) await this.#scheduleTokenRefresh();
      throw this.#translate(error);
    }
    this.#cancelTokenRefresh(true);
    this.#listenAbort.abort();
  }

  // ---- catalog and profile ----

  async refreshOwnProfile(): Promise<TransportIdentity> {
    if (this.#revoked || !this.#full.authToken) throw new Error('LINE profile read is unavailable');
    const profile = await this.#linejs(() => this.#client.getMyProfile()) as { mid?: unknown; displayName?: unknown; picturePath?: unknown };
    if (!profile || typeof profile.mid !== 'string' || !/^u[0-9a-f]{32}$/i.test(profile.mid)) throw new Error('LINE profile response is invalid');
    const path = picturePath(profile.picturePath, Object.hasOwn(profile, 'picturePath'));
    const displayName = typeof profile.displayName === 'string' && profile.displayName.length <= 256 ? profile.displayName : null;
    return { ownMid: profile.mid.toLowerCase(), displayName, ...(path === undefined ? {} : { picturePath: path }) };
  }

  #member(memberId: string) {
    const info = this.#users.get(memberId);
    return { memberId, displayName: info?.displayName ?? null,
      ...(info?.nickname === undefined ? {} : { nickname: info.nickname }),
      ...(info?.picturePath === undefined ? {} : { picturePath: info.picturePath }),
      ...(info?.friend === undefined ? {} : { friend: info.friend }) };
  }

  #chatItem(chat: Chat): ConversationCatalogItem | null {
    const type = chatKind(chat.mid);
    if (type !== 'group' && type !== 'room') return null;
    const raw = chat.raw as unknown as { chatName?: unknown; picturePath?: unknown; extra?: { groupExtra?: { memberMids?: unknown } } };
    const memberIds = stringIds(raw.extra?.groupExtra?.memberMids).sort();
    const path = picturePath(raw.picturePath, Object.hasOwn(raw, 'picturePath'));
    return { chatType: type, chatId: chat.mid, title: typeof raw.chatName === 'string' && raw.chatName.length > 0 ? raw.chatName : null,
      members: memberIds.map((memberId) => this.#member(memberId)), ...(path === undefined ? {} : { picturePath: path }) };
  }

  /**
   * `LinejsFullClient.getSettings` (linejs `base.talk.getSettings()`), one call, no retry. Only `phoneRegistration` is read.
   * The other fields (for example the e-mail identifier) are dropped here and are never kept or logged.
   */
  async readPhoneRegistration(): Promise<boolean | null> {
    if (this.#revoked || !this.#full.authToken) throw new Error('LINE settings read is unavailable');
    const settings = await this.#linejs(() => this.#full.getSettings()) as { phoneRegistration?: unknown } | undefined;
    return typeof settings?.phoneRegistration === 'boolean' ? settings.phoneRegistration : null;
  }

  /** `client.fetchJoinedChats()` and `client.fetchUsers()` (client/client.ts). */
  async listConversations(): Promise<readonly ConversationCatalogItem[]> {
    const chats = await this.#linejs(() => this.#client.fetchJoinedChats());
    const users = await this.#linejs(() => this.#client.fetchUsers());
    this.#users.clear();
    const items: ConversationCatalogItem[] = [];
    for (const user of users) {
      const raw = user.raw as unknown as { targetProfileDetail?: { profileName?: unknown; picturePath?: unknown };
        friendDetail?: { user?: { overriddenName?: unknown } }; blockDetail?: { user?: unknown };
        contact?: { displayName?: unknown; displayNameOverridden?: unknown; picturePath?: unknown; status?: unknown } };
      // `fetchUsers()` is the linejs friend list (`getUserFriendIds`, client/client.ts:314).
      // V3 shape (getContactsV3): `blockDetail.user` marks a blocked friend.
      // V2 shape (client/client.js:242-255, when V3 is API_NOT_CAPABLE): `{ ...ContactEntry, targetUserMid }`, the data is in `contact`.
      const v2 = typeof raw.contact === 'object' && raw.contact !== null ? raw.contact : undefined;
      const detail = raw.targetProfileDetail ?? (v2 ? { profileName: v2.displayName, ...(Object.hasOwn(v2, 'picturePath') ? { picturePath: v2.picturePath } : {}) } : undefined);
      const friend = v2 ? !(v2.status === 2 || v2.status === 'FRIEND_BLOCKED') : !raw.blockDetail?.user;
      const displayName = typeof detail?.profileName === 'string' ? detail.profileName : null;
      const overridden = v2 ? v2.displayNameOverridden : raw.friendDetail?.user?.overriddenName;
      const nickname = typeof overridden === 'string' && overridden.length > 0 ? overridden.slice(0, 256) : undefined;
      const path = picturePath(detail?.picturePath, detail !== undefined && Object.hasOwn(detail, 'picturePath'));
      const info: UserInfo = { displayName, ...(nickname === undefined ? {} : { nickname }), ...(path === undefined ? {} : { picturePath: path }), friend };
      this.#users.set(user.mid, info);
      items.push({ chatType: 'direct', chatId: user.mid, title: nickname ?? displayName, members: [this.#member(user.mid)],
        ...(path === undefined ? {} : { picturePath: path }) });
    }
    for (const chat of chats) {
      const item = this.#chatItem(chat);
      if (item) items.push(item);
    }
    return items;
  }

  /** `client.getChat(mid)` (client/client.ts) for each group or room id. */
  async listConversationDetails(chatIds: readonly string[]): Promise<readonly ConversationCatalogItem[]> {
    const items: ConversationCatalogItem[] = [];
    for (const chatId of new Set(chatIds)) {
      const type = chatKind(chatId);
      if (type !== 'group' && type !== 'room') continue;
      let chat: Chat;
      try { chat = await this.#linejs(() => this.#client.getChat(chatId)); } catch (error) {
        if (error instanceof TypeError) continue; // linejs builds a Chat from an empty answer: the chat is unknown to LINE.
        throw error;
      }
      const item = this.#chatItem(chat);
      if (item) items.push(item);
    }
    return items;
  }

  // ---- receive ----

  async sync(cursor: TalkCursorV1Dto): Promise<SyncResult> {
    if (this.#revoked) throw new EffectDeniedError('transport is revoked');
    if (this.#streamError !== undefined) {
      const error = this.#streamError;
      this.#streamError = undefined;
      throw this.#translate(error);
    }
    if (!this.#talkStarted || this.#restartTalk) {
      if (!this.#talkStarted) {
        this.#full.setTalkCursor({ revision: BigInt(cursor.revision), globalRev: BigInt(cursor.globalRev),
          individualRev: BigInt(cursor.individualRev) });
      }
      this.#talkStarted = true;
      this.#restartTalk = false;
      this.#client.listen({ talk: true, square: false, signal: this.#listenAbort.signal });
    }
    const settled = () => this.#talkQueue.every((entry) => entry.state !== 'pending');
    await this.#waitUntil(() => this.#revoked || this.#streamError !== undefined || (this.#talkQueue.length > 0 && settled()));
    // linejs sets the cursor for a whole response before it queues the operations. Let the rest of that burst arrive,
    // and wait until no operation is still decrypting, so `cursorAfter` never passes an operation that this call did not return.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.#waitUntil(() => this.#revoked || settled());
    const batch: TalkEntry[] = [];
    // The worker loop refuses a batch of more than 100 operations. After a long offline time linejs fetches the backlog in
    // responses of 100 operations without waiting, so more can be queued. The rest stays in the queue for the next call.
    while (this.#talkQueue.length > 0 && this.#talkQueue[0]!.state !== 'pending' && batch.length < MAX_BATCH) batch.push(this.#talkQueue.shift()!);
    const operations: SyncItem[] = [];
    for (const entry of batch) {
      if (entry.state === 'failed') operations.push({ operation: entry.op, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } });
      else if (entry.op.message !== undefined && entry.op.message !== null) operations.push(entry.op);
      else this.#collector.add(entry.op);
    }
    const previous = this.#lastCursor ?? cursor;
    const after = this.#full.getTalkCursor();
    let cursorAfter: TalkCursorV1Dto;
    if (this.#talkQueue.length === 0) {
      cursorAfter = { version: 1, revision: decimal(after.revision, previous.revision),
        globalRev: decimal(after.globalRev, previous.globalRev), individualRev: decimal(after.individualRev, previous.individualRev) };
    } else {
      // Operations still wait in the queue, so the linejs cursor is ahead of this batch. Move only the revision to the last returned
      // operation. The two event revisions stay, so after a restart LINE sends the rest again and no operation is lost.
      const last = batch.at(-1)?.op.revision;
      const revision = last === undefined ? previous.revision : decimal(last, previous.revision);
      cursorAfter = { ...previous, revision: BigInt(revision) > BigInt(previous.revision) ? revision : previous.revision };
    }
    this.#lastCursor = cursorAfter;
    const readReceipts = this.#collector.receipts();
    const unsends = this.#collector.unsends();
    this.#collector.reset();
    return { cursorAfter, operations, rawOperationCount: batch.length,
      ...(readReceipts.length === 0 ? {} : { readReceipts }), ...(unsends.length === 0 ? {} : { unsends }) };
  }

  /** The linejs listener for Square events (`client.listen({ square: true })`). Tokens come from `LinejsFullClient.getSquareToken`. */
  async syncSquare(request: Readonly<{ syncToken?: string; continuationToken?: string }>): Promise<SquareSyncResult> {
    if (this.#revoked) throw new EffectDeniedError('transport is revoked');
    // linejs starts the Talk and the Square push on one connection. The Talk cursor must be set before that connection starts.
    if (!this.#talkStarted) {
      await this.#waitUntil(() => this.#talkStarted || this.#revoked);
      if (!this.#talkStarted) return { events: [], syncToken: null, continuationToken: null };
    }
    if (!this.#squareStarted) {
      this.#squareStarted = true;
      if (request.syncToken !== undefined) this.#full.setSquareToken(request.syncToken);
      this.#client.listen({ talk: false, square: true, signal: this.#listenAbort.signal });
    }
    await this.#waitUntil(() => this.#revoked || this.#squareQueue.length > 0);
    const events = this.#squareQueue.splice(0);
    return { events, syncToken: this.#full.getSquareToken() ?? null, continuationToken: null };
  }

  /** `client.getSquareChat(mid)` (client/client.ts). */
  async getSquareChatTitle(squareChatMid: string): Promise<string | null> {
    const chat = await this.#linejs(() => this.#client.getSquareChat(squareChatMid), 'getSquareChat');
    const name = (chat.raw as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  }

  // ---- history, resources, download ----

  /**
   * Group or room, first page: `Chat.fetchMessages` (client/features/chat/mod.ts), as CLI chats.ts:105-107.
   * Direct, first page: CLI shared.ts:77-105 (message box, then getPreviousMessagesV2WithRequest).
   * Later pages: the same getPreviousMessagesV2WithRequest call as client/features/chat/fetcher.ts, with the given cursor.
   */
  async history(conversation: Conversation, cursor: HistoryCursorV1 | null, limit: number): Promise<readonly unknown[]> {
    if (cursor && (cursor.accountId !== this.#options.accountId || cursor.chatType !== conversation.chatType
      || cursor.chatId !== conversation.chatId)) throw new EffectDeniedError('history cursor conversation mismatch');
    const full = this.#full;
    const messages = await this.#linejs(async () => {
      if (cursor) {
        return await full.fetchPreviousMessages({ messageBoxId: conversation.chatId,
          endMessageId: { messageId: BigInt(cursor.messageId), deliveredTime: BigInt(cursor.deliveredTime) }, messagesCount: limit });
      }
      if (conversation.chatType !== 'direct') {
        return await full.fetchChatMessages(conversation.chatId, limit);
      }
      const boxes = await full.getMessageBoxes();
      const box = boxes.messageBoxes.find((entry) => entry.id === conversation.chatId);
      if (!box) throw new Error('Message box not found.');
      return await full.fetchPreviousMessages({ messageBoxId: box.id,
        endMessageId: { messageId: box.lastDeliveredMessageId.messageId, deliveredTime: box.lastDeliveredMessageId.deliveredTime },
        messagesCount: limit });
    });
    return messages.map((message) => message.raw);
  }

  /** Notes: CLI timeline.ts. Albums and photos: CLI moa.ts. See linejs-client-engine-resources.ts. */
  async readChatResource(command: ChatResourceReadCommand, options: Readonly<{ signal: AbortSignal }>): Promise<ChatResourceValue> {
    try { return await readLinejsChatResource(this.#full, command, options.signal); } catch (error) {
      const named = requestName(error);
      if (named) this.#observeAuth(error, named.path, named.method);
      throw error;
    }
  }

  /**
   * CLI messages.ts:267-280 (`messages data`, `media download`): `LinejsFullClient.downloadMessageData` (`TalkMessage.getData()`).
   * The stored message is checked first by `validateAttachmentMessage`. It refuses a DOWNLOAD_URL, so linejs never fetches an outside URL.
   */
  async download(_kind: 'image' | 'video' | 'audio' | 'file', _messageId: string, _externalAttachmentId: string,
    lineMessage: JsonValue, options: Readonly<{ signal: AbortSignal; maxBytes: number;
      identity: Parameters<typeof validateAttachmentMessage>[1] }>): Promise<{ name: string | null; source: AsyncIterable<Uint8Array> }> {
    if (!this.#full.authToken) throw new EffectDeniedError('download requires login');
    const { signal, maxBytes } = options;
    const cancelled = () => new SafeAttachmentError('LINE_DOWNLOAD_CANCELLED');
    if (signal.aborted) throw cancelled();
    const parsed = validateAttachmentMessage(lineMessage, options.identity, maxBytes);
    let blob: Blob;
    let name: string | null = null;
    try {
      // Aborting stops the reading only. The linejs request is not cancelled.
      if (parsed.encrypted) {
        // linejs `obs.downloadMediaByE2EE` returns the file name of an E2EE file with the data (`TalkMessage.getData()` drops it).
        const file = await this.#linejs(() => this.#full.downloadE2eeMessageFile(parsed.message as never,
          (data) => Promise.race([data, aborted(signal)])));
        if (!file) throw new SafeAttachmentError('LINE_NATIVE_DOWNLOAD_FAILED');
        blob = file;
        if (typeof file.name === 'string' && file.name.length >= 1 && file.name.length <= 255) name = file.name;
      } else {
        blob = await this.#linejs(() => this.#full.downloadMessageData(parsed.message as never,
          (data) => Promise.race([data, aborted(signal)])));
      }
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw error;
    }
    if (blob.size > maxBytes) throw new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
    async function* chunks(): AsyncIterable<Uint8Array> {
      const reader = blob.stream().getReader();
      let total = 0;
      try {
        while (true) {
          if (signal.aborted) throw cancelled();
          const item = await reader.read();
          if (item.done) return;
          total += item.value.byteLength;
          if (total > maxBytes) throw new SafeAttachmentError('LINE_MEDIA_SIZE_LIMIT');
          yield item.value;
        }
      } finally { await reader.cancel().catch(() => undefined); }
    }
    return { name, source: chunks() };
  }

  // ---- send ----

  /**
   * Group or room: `client.getChat(mid)` then `Chat.sendMessage` (client/features/chat/mod.ts).
   * Direct, any user MID: CLI chats.ts:189-198 (`chats send`): `LinejsFullClient.sendToUser`.
   * A reply sets `relatedMessageId` (CLI `--reply-to`). Mentions go in `contentMetadata.MENTION`.
   */
  async send(conversation: Conversation, text: string, replyToMessageId: string | null, lease: ControlLease,
    manual = false, mentions: readonly OutgoingMention[] = []): Promise<{ messageId: string }> {
    this.#requireWrite(lease, manual);
    this.#requireConversation(conversation);
    const contentMetadata = mentions.length > 0 ? { MENTION: buildMentionContentMetadata(mentions) } : undefined;
    const relatedMessageId = replyToMessageId === null ? undefined : replyToMessageId;
    if (conversation.chatType === 'direct') {
      const sent = await this.#linejs(() => this.#full.sendToUser({ to: conversation.chatId, text,
        ...(contentMetadata === undefined ? {} : { contentMetadata }),
        ...(relatedMessageId === undefined ? {} : { relatedMessageId }) }));
      return { messageId: String(sent.id) };
    }
    // The same `base.talk.sendMessage` call as `Chat.sendMessage`, without its decrypt of our own message after the send.
    const sent = await this.#linejs(() => this.#full.sendToChat({ to: conversation.chatId, text,
      ...(contentMetadata === undefined ? {} : { contentMetadata }),
      ...(relatedMessageId === undefined ? {} : { relatedMessageId }) }));
    return { messageId: String(sent.id) };
  }

  /**
   * CLI chats.ts:237-266 (`chats send-media`) and media.ts (`media upload`):
   * `LinejsFullClient.sendMedia` (`uploadMediaByE2EE`). The type follows the CLI rule: a GIF file is `gif`.
   */
  async sendMedia(conversation: { chatType: 'direct' | 'group'; chatId: string },
    media: Readonly<{ kind: 'image' | 'file'; bytes: Buffer; fileName: string }>, lease: ControlLease, manual = false): Promise<{ messageId: string }> {
    this.#requireWrite(lease, manual);
    this.#requireConversation(conversation);
    const oType = media.kind === 'image' && /\.gif$/i.test(media.fileName) ? 'gif' : media.kind;
    const sent = await this.#linejs(() => this.#full.sendMedia({ data: new Blob([new Uint8Array(media.bytes)]),
      oType, to: conversation.chatId, filename: media.fileName }));
    return { messageId: String(sent.id) };
  }

  /** CLI messages.ts:58 (`messages react`: `LinejsFullClient.react`) and messages.ts:78-83 (`LinejsFullClient.cancelReaction` for UNDO). */
  async react(conversation: Conversation, messageId: string,
    reaction: Parameters<LineTransport['react']>[2], lease: ControlLease): Promise<void> {
    this.#requireWrite(lease);
    this.#requireConversation(conversation);
    if (!int64(messageId)) throw new EffectDeniedError('message ID is not a LINE int64');
    if (reaction === 'UNDO') {
      await this.#linejs(() => this.#full.cancelReaction(BigInt(messageId)));
      return;
    }
    await this.#linejs(() => this.#full.react({ id: BigInt(messageId), reaction: reaction as never }));
  }

  /** CLI messages.ts:103 (`messages unsend`) and TalkMessage.unsend: `LinejsFullClient.unsend`. */
  async unsend(conversation: Conversation, messageId: string, lease: ControlLease): Promise<void> {
    this.#requireWrite(lease, true);
    this.#requireConversation(conversation);
    if (!int64(messageId)) throw new EffectDeniedError('message ID is not a LINE int64');
    await this.#linejs(() => this.#full.unsend(messageId));
  }

  // ---- relation ----

  async checkFriendRelation(targetMid: string, lease: ControlLease, signal?: RelationCancellation): Promise<FriendRelation> {
    return (await this.checkFriendRelationDiagnostic(targetMid, lease, signal)).status;
  }

  /** `client.getUser(mid)` (client/client.ts, getContactsV3). Friend when the friend detail is a user; not a friend when it is `notFriend`. */
  async checkFriendRelationDiagnostic(targetMid: string, _lease: ControlLease, signal: RelationCancellation = { aborted: false }): Promise<FriendRelationDiagnostic> {
    const unknown = (error: string): FriendRelationDiagnostic => ({ status: 'unknown', error });
    if (this.#revoked) return unknown('RELATION_BINDING_REVOKED');
    if (signal.aborted) return unknown('RELATION_CANCELLED');
    try {
      const user = await this.#linejs(() => this.#client.getUser(targetMid));
      if (signal.aborted) return unknown('RELATION_CANCELLED');
      const detail = (user.raw as unknown as { friendDetail?: { user?: unknown; notFriend?: unknown } } | undefined)?.friendDetail;
      if (detail?.user) return { status: 'friend', error: null };
      if (detail?.notFriend) return { status: 'not_friend', error: null };
      return unknown('RELATION_STATUS_UNAVAILABLE');
    } catch (error) {
      if (signal.aborted) return unknown('RELATION_CANCELLED');
      return { status: 'unknown', error: 'RELATION_LIST_RPC_FAILED', ...safeChatResourceFailureDetails(error) };
    }
  }

  /**
   * Friend add is disabled in this engine: two account bans came from friend add
   * and first messages to strangers. No request is made.
   */
  async addFriendByMid(_targetMid: string, _lease: ControlLease, _onPhysicalStart: () => void,
    _signal: RelationCancellation = { aborted: false }, _sourceChatMid?: string): Promise<FriendAddResult> {
    return { status: 'failed', error: 'SIDE_EFFECT_DENIED' };
  }

  revoke(): void {
    this.#revoked = true;
    this.#cancelTokenRefresh(true);
    this.#listenAbort.abort();
    this.#poke();
  }
}

export function createLinejsClientEngine(options: LinejsClientEngineOptions): LinejsClientEngine {
  return new LinejsClientEngine(options);
}
