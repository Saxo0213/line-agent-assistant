import { createHash, randomUUID } from 'node:crypto';
import {
  isLineServerErrorCode, isLocalAgentRoom, talkServerError, MEDIA_FILE_MAX_BYTES, MEDIA_IMAGE_MAX_BYTES, LineWorkerCommandSchema, LineWorkerEventSchema,
  WORKER_PROTOCOL_VERSION, type ConversationCatalogItem, type JsonValue as ContractJsonValue, type LineWorkerCommand, type LineWorkerEvent, type TalkCursorV1Dto,
  type ChatResourceReadCommand, type OutgoingMention, type ChatResourcePhotoPageShape,
} from '@line-agent/contracts';
import { DurableCursorSession, cursorsEqual, decodeHistoryCursor, encodeHistoryCursor,
  type HistoryCursorV1, type JsonValue } from './cursor.js';
import { EffectDeniedError, type ControlLease } from './mutation-gate.js';
import { normalizeOperation, type DecryptionFailure } from './normalizer.js';
import { mkdir, open, statfs } from 'node:fs/promises';
import { sanitizeAttachmentFilename, storeAttachment, type AttachmentStoreRuntime } from './attachment-store.js';
import { IMAGE_SNIFF_PREFIX_BYTES, fallbackAttachmentFileName, peekAttachmentSource } from './attachment-peek.js';
import { SafeAttachmentError } from './attachment-error.js';
import { validateAttachmentMessage, type AttachmentDownloadIdentity } from './attachment-download.js';
import { isChatResourceFailure, isChatResourceUnsupported, safeChatResourceFailureDetails, type ChatResourceFailureKind, type ChatResourceResponseCode } from './chat-resource-error.js';
import { isLineServerRejection } from './line-server-error.js';
import { tagLoginStage } from './login-failure-detail.js';

export type TransportIdentity = Readonly<{ ownMid: string; displayName: string | null; picturePath?: string | null }>;
export type SyncItem = unknown | Readonly<{
  operation: unknown; source?: 'live' | 'history'; decryptionError?: DecryptionFailure;
}>;
export type SyncResult = Readonly<{ cursorAfter: TalkCursorV1Dto; operations: readonly SyncItem[];
  /** Number of raw Talk.sync operations before adapters append bounded recent-history catch-up items. */
  rawOperationCount?: number; hasMoreStartupItems?: boolean;
  readReceipts?: readonly Readonly<{ chatId: string; readerMid: string; messageId: string; readAt: string }>[];
  /** LINE unsend operations (OpType 64 and 65) observed in this sync response. */
  unsends?: readonly Readonly<{ chatId: string; messageId: string; kind: 'self' | 'notified'; observedAt: string }>[] }>;
export type FriendRelation = 'friend' | 'not_friend' | 'unknown';
export type FriendRelationDiagnostic = Readonly<{ status: FriendRelation; error: string | null; failureKind?: ChatResourceFailureKind;
  upstreamStatus?: number; upstreamCode?: ChatResourceResponseCode }>;
export type FriendAddResult = Readonly<{ status: 'added' | 'failed' | 'unknown'; error: string | null }>;

const FRIEND_ADD_LOCAL_FAILURES = new Set(['SIDE_EFFECT_DENIED', 'NOT_STARTED', 'NOT_READY', 'REQUEST_ID_CONFLICT', 'QUEUE_FULL']);
const CHAT_DETAIL_BATCH_LIMIT = 100;
export const LOGOUT_DEADLINE_MS = 10_000;
export const SYNC_CONFIRMED_INTERVAL_MS = 60_000;
function safeFriendAddResult(result: FriendAddResult): FriendAddResult {
  if (result.status === 'added') return { status: 'added', error: null };
  if (result.status === 'failed' && typeof result.error === 'string' &&
    (FRIEND_ADD_LOCAL_FAILURES.has(result.error)
      || (result.error.startsWith('LINE_RELATION_ADD_') && isLineServerErrorCode(result.error)))) return result;
  return { status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' };
}
export type RelationCancellation = Readonly<{ aborted: boolean }>;
export interface LineTransport {
  on(event: 'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated' | 'refreshFailure', listener: (value?: any) => void): void;
  installSecrets(secrets: { token: string | null; qrCert: string | null; e2eeStorage: ContractJsonValue | null }): Promise<void>;
  loginQr(): Promise<TransportIdentity>;
  loginToken(token: string): Promise<TransportIdentity>;
  logoutServer?(signal?: AbortSignal): Promise<void>;
  listConversations(): Promise<readonly ConversationCatalogItem[]>;
  /** Group ('c') and room ('r') ids that the catalog has not seen, at most 100. Same item shape as `listConversations`. */
  listConversationDetails?(chatIds: readonly string[]): Promise<readonly ConversationCatalogItem[]>;
  refreshOwnProfile?(): Promise<TransportIdentity>;
  sync(cursor: TalkCursorV1Dto): Promise<SyncResult>;
  history(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string },
    cursor: HistoryCursorV1 | null, limit: number): Promise<readonly unknown[]>;
  readChatResource?(command: ChatResourceReadCommand, options: Readonly<{ signal: AbortSignal }>): Promise<Readonly<{
    nextCursor?: string | null; notes?: readonly unknown[]; note?: unknown; albums?: readonly unknown[];
    photos?: readonly unknown[]; photoPageShape?: ChatResourcePhotoPageShape; bytes?: Uint8Array;
  }>>;
  download(kind: 'image' | 'video' | 'audio' | 'file', messageId: string,
    externalAttachmentId: string, lineMessage: ContractJsonValue,
    options: Readonly<{ signal: AbortSignal; maxBytes: number; identity: AttachmentDownloadIdentity }>): Promise<{
      name: string | null; source: AsyncIterable<Uint8Array>;
    }>;
  send(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, text: string,
    replyToMessageId: string | null, lease: ControlLease, manual?: boolean, mentions?: readonly OutgoingMention[]): Promise<{ messageId: string }>;
  /** Optional: transports without media support leave it undefined and the loop denies the command. */
  sendMedia?(conversation: { chatType: 'direct' | 'group'; chatId: string },
    media: Readonly<{ kind: 'image' | 'file'; bytes: Buffer; fileName: string }>, lease: ControlLease, manual?: boolean): Promise<{ messageId: string }>;
  react(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, messageId: string,
    reaction: Extract<LineWorkerCommand, { type: 'reactMessage' }>['reaction'], lease: ControlLease): Promise<void>;
  unsend?(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, messageId: string, lease: ControlLease): Promise<void>;
  checkFriendRelation(targetMid: string, lease: ControlLease, signal?: RelationCancellation): Promise<FriendRelation>;
  checkFriendRelationDiagnostic?(targetMid: string, lease: ControlLease, signal?: RelationCancellation): Promise<FriendRelationDiagnostic>;
  addFriendByMid(targetMid: string, lease: ControlLease, onPhysicalStart: () => void, signal?: RelationCancellation,
    sourceChatMid?: string): Promise<FriendAddResult>;
  revoke?(): void;
}

/** Step of a media send that failed before `sendMessage` started. The set is closed; it never holds free text. */
export type MediaUploadStage = 'media_size' | 'e2ee_flow' | 'encrypt' | 'obs_upload' | 'obs_preview' | 'e2ee_message';

/** Error class name reduced to letters only (at most 40 characters). Undefined when the value has no usable class. */
export function boundedErrorClass(error: unknown): string | undefined {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name !== 'string') return undefined;
    return name.replace(/[^A-Za-z]/g, '').slice(0, 40) || undefined;
  } catch { return undefined; }
}

/** One numeric LINE code or HTTP status of an error, if it has one. LINE codes come first because they are more exact. */
export function boundedErrorNumber(error: unknown): number | undefined {
  try {
    if (error === null || typeof error !== 'object') return undefined;
    const record = error as { innerCode?: unknown; code?: unknown; status?: unknown };
    for (const value of [record.innerCode, record.code, record.status]) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000) return value;
    }
  } catch { /* A hostile getter is not evidence. */ }
  return undefined;
}

/**
 * Thrown by a transport when a media send failed before `sendMessage` started: nothing was sent.
 * `stage`, `causeClass` and `causeNumber` are bounded evidence; the error keeps no message text, path, key or token.
 */
export class MediaUploadFailedError extends Error {
  readonly code = 'UPLOAD_FAILED';
  readonly stage: MediaUploadStage | undefined;
  readonly causeClass: string | undefined;
  readonly causeNumber: number | undefined;
  constructor(stage?: MediaUploadStage, cause?: unknown) {
    super('LINE media upload failed');
    this.name = 'MediaUploadFailedError';
    this.stage = stage;
    this.causeClass = boundedErrorClass(cause);
    this.causeNumber = boundedErrorNumber(cause);
  }
  /** Safe detail text for the sendResult event: stage, cause class and number joined by a colon. */
  get detail(): string | undefined {
    const parts = [this.stage, this.causeClass, this.causeNumber === undefined ? undefined : String(this.causeNumber)]
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(':') : undefined;
  }
}

const taggedStages = new WeakMap<object, MediaUploadStage>();
/** Remembers the media step in which a gate denial or a LINE rejection happened. Returns the same error. */
export function tagMediaStage<T>(error: T, stage: MediaUploadStage): T {
  if (error !== null && typeof error === 'object') taggedStages.set(error, stage);
  return error;
}
/** Safe detail of a media send failure: upload failures and tagged gate denials or LINE rejections. */
export function mediaFailureDetail(error: unknown): string | undefined {
  if (error instanceof MediaUploadFailedError) return error.detail;
  const stage = error !== null && typeof error === 'object' ? taggedStages.get(error) : undefined;
  if (stage === undefined) return undefined;
  return [stage, boundedErrorClass(error), boundedErrorNumber(error)].filter((part) => part !== undefined).join(':');
}

class MediaFileError extends Error {
  constructor(readonly code: 'FILE_CHANGED' | 'FILE_UNREADABLE') { super(code); }
}

export type LineWorkerOptions = Readonly<{
  transport: LineTransport;
  emit: (event: LineWorkerEvent) => void | Promise<void>;
  validateLease: (lease: ControlLease) => boolean | Promise<boolean>;
  attachmentRoot?: string;
  attachmentRuntime?: AttachmentStoreRuntime;
  minFreeBytes?: number;
}>;

type InitCommand = Extract<LineWorkerCommand, { type: 'init' }>;
type SecretState = Extract<LineWorkerCommand, { type: 'setSecretState' }>['secrets'];

function attachmentFailureCode(error: unknown, stage: 'PREPARE' | 'LINE_DOWNLOAD' | 'STORE', aborted: boolean): string {
  if (error instanceof SafeAttachmentError) return error.code;
  if (aborted) {
    const reason = error as { code?: unknown } | null;
    return reason?.code === 'TIMEOUT' ? 'LINE_DOWNLOAD_TIMEOUT' : 'LINE_DOWNLOAD_CANCELLED';
  }
  if (stage === 'LINE_DOWNLOAD') {
    return error instanceof TypeError ? 'LINE_NETWORK_FAILED' : 'LINE_NATIVE_DOWNLOAD_FAILED';
  }
  return stage === 'PREPARE' ? 'ATTACHMENT_PREPARE_FAILED' : 'ATTACHMENT_STORE_FAILED';
}

export class LineWorkerLoop {
  readonly #transport: LineTransport;
  readonly #emitEvent: LineWorkerOptions['emit'];
  readonly #validateLease: LineWorkerOptions['validateLease'];
  readonly #attachmentRoot: string | undefined;
  readonly #attachmentRuntime: AttachmentStoreRuntime;
  readonly #minFreeBytes: number;
  #binding?: InitCommand;
  #cursor?: DurableCursorSession<JsonValue>;
  #lastAckedBatch: { batchId: string } | undefined;
  #secrets: SecretState = { token: null, qrCert: null, e2eeStorage: null };
  #loginAttemptId?: string;
  #loginInFlight = false;
  #secretRestoreInFlight = false;
  #ownMid: string | undefined;
  #revoked = false;
  #stopped = false;
  #polling = false;
  #startupSync = true;
  #startupFinalBatchId: string | undefined;
  #lastStartupCompleteBatchId: string | undefined;
  #receiveGeneration = 0;
  readonly #usedEffectPermits = new Set<string>();
  #syncFailures = 0;
  #lastSyncConfirmedAt = 0;
  #sending = false;
  #currentSend: Promise<void> | undefined;
  readonly #addLedger = new Map<string, { targetMid: string; sourceChatMid?: string; result: Promise<FriendAddResult> }>();
  #relationPending = 0;
  #relationTail: Promise<void> = Promise.resolve();
  #eventTail: Promise<void> = Promise.resolve();
  #eventFailure?: Error;
  #pendingEvents = 0;
  #activeDownloads = 0;
  #activeTransportCalls = 0;
  #profileReadInFlight = false;
  #credentialSwapPending = false;
  #transportQuarantined = false;
  #authInvalidated = false;
  #transportGeneration = 0;
  #catalogRefreshGeneration = 0;
  #catalogRefreshFlight: Promise<void> | undefined;
  #catalogPollTicks = 0;
  #catalogRetryAttempt = 0;
  #catalogRetryAtTick = 0;
  #catalogRequested = false;
  #catalogFailureReported = false;
  #catalogRefreshComplete = false;
  // Chats that arrived after the full catalog are read once per session (official talkChat/fetchTalkChats: getChats for unknown mids).
  readonly #knownChatIds = new Set<string>();
  readonly #pendingDetailIds = new Set<string>();
  #detailFlight: Promise<void> | undefined;
  #detailRetryAttempt = 0;
  #detailRetryAtTick = 0;
  readonly #transportDrainWaiters: Array<() => void> = [];
  readonly #activeAttachments = new Map<string, { attachmentId: string; controller: AbortController; finished: Promise<void>; finish(): void }>();
  readonly #activeChatResourceReads = new Map<string, AbortController>();
  readonly #downloadWaiters: Array<Readonly<{
    resolve(): void; reject(error: Error): void; signal: AbortSignal; onAbort(): void;
  }>> = [];

  constructor(options: LineWorkerOptions) {
    this.#transport = options.transport;
    this.#emitEvent = options.emit;
    this.#validateLease = options.validateLease;
    this.#attachmentRoot = options.attachmentRoot;
    this.#attachmentRuntime = options.attachmentRuntime ?? {};
    this.#minFreeBytes = options.minFreeBytes ?? 512 * 1024 * 1024;
    this.#transport.on('authInvalidated', () => {
      if (this.#authInvalidated || !this.#binding) return;
      this.#authInvalidated = true;
      this.#receiveGeneration += 1;
      this.#catalogRefreshGeneration += 1;
      this.#transport.revoke?.();
      void this.#emit({ type: 'authInvalidated', ...this.#identity() }).catch(() => undefined);
    });
    // Listener registration is deliberately ahead of every login call.
    this.#transport.on('qr', (code: string) => { if (!this.#stopped) this.#emitLoginEvent('qr', { code }); });
    this.#transport.on('pin', (pin: string) => { if (!this.#stopped) this.#emitLoginEvent('pin', { pin }); });
    this.#transport.on('token', (token: string) => {
      if (this.#stopped) return;
      this.#secrets = { ...this.#secrets, token };
      this.#emitSecretRotation();
    });
    this.#transport.on('qrCert', (qrCert: string) => {
      if (this.#stopped) return;
      this.#secrets = { ...this.#secrets, qrCert };
      this.#emitSecretRotation();
    });
    this.#transport.on('storage', (e2eeStorage: ContractJsonValue) => {
      if (this.#stopped) return;
      this.#secrets = { ...this.#secrets, e2eeStorage };
      this.#emitSecretRotation();
    });
    this.#transport.on('credentials', (credentials: { token: string; e2eeStorage: ContractJsonValue }) => {
      if (this.#stopped) return;
      this.#secrets = { ...this.#secrets, token: credentials.token, e2eeStorage: credentials.e2eeStorage };
      this.#emitSecretRotation();
    });
    this.#transport.on('refreshFailure', () => {
      if (this.#stopped || !this.#binding) return;
      void this.#emit({ type: 'error', ...this.#identity(), code: 'WORKER_OPERATION_FAILED',
        message: 'LINE token refresh failed', retryable: true,
        diagnostic: { operation: 'loginToken', stage: 'execute', category: 'transport_failed', recovery: 'retry', outcome: 'failed' } })
        .catch(() => undefined);
    });
  }

  get durableCursor(): TalkCursorV1Dto {
    if (!this.#cursor) throw new Error('worker is not initialized');
    return this.#cursor.durableCursor;
  }

  get authInvalidated(): boolean { return this.#authInvalidated; }

  async flushEvents(): Promise<void> {
    await this.#eventTail;
    if (this.#eventFailure) throw this.#eventFailure;
  }

  async handle(input: unknown): Promise<void> {
    const command = LineWorkerCommandSchema.parse(input);
    const bound = this.#binding;
    if ((command.type === 'revokeControl' || command.type === 'stop') && bound &&
      command.accountId === bound.accountId && command.workerInstanceId === bound.workerInstanceId &&
      command.controlEpoch === bound.controlEpoch) {
      this.#revoked = true;
      if (command.type === 'stop') this.#stopped = true;
      for (const controller of this.#activeChatResourceReads.values()) controller.abort(new Error('Worker authority changed'));
      this.#transport.revoke?.();
      this.#catalogRefreshGeneration += 1;
      if (command.type === 'stop') this.#receiveGeneration += 1;
    }
    if (this.#eventFailure && ['setSecretState', 'loginQr', 'loginToken', 'poll', 'history', 'chatResourceRead', 'sendText', 'manualSendText', 'sendMedia', 'downloadAttachment', 'checkFriendRelation', 'addFriendByMid', 'unsendMessage'].includes(command.type)) {
      if (command.type === 'loginQr' || command.type === 'loginToken') tagLoginStage(this.#eventFailure, 'event_failure');
      throw this.#eventFailure;
    }
    if (command.type === 'init') {
      if (this.#binding) throw new Error('worker initialization is immutable');
      this.#binding = Object.freeze({ ...command });
      this.#cursor = new DurableCursorSession(command.accountId, command.durableCursor);
      await this.#emit({ type: 'workerProtocolAck', ...this.#identity(), protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
      await this.#emit({ type: 'modeAck', ...this.#identity(), mode: command.mode, drained: true });
      return;
    }
    const binding = this.#binding;
    if (!binding) throw new Error('worker must be initialized first');
    if (command.accountId !== binding.accountId || command.workerInstanceId !== binding.workerInstanceId ||
      command.controlEpoch !== binding.controlEpoch ||
      command.transportOwnerId !== binding.transportOwnerId ||
      command.transportGeneration !== binding.transportGeneration ||
      command.writeGrantVersion !== binding.writeGrantVersion) throw new Error('worker binding mismatch');
    if (this.#authInvalidated && command.type !== 'stop' && command.type !== 'revokeControl' && command.type !== 'logout') {
      if (command.type === 'poll') return;
      throw new Error('LINE authentication is invalidated');
    }
    if (binding.mode === 'PAUSED' && ['loginQr', 'loginToken', 'poll', 'history', 'downloadAttachment', 'refreshOwnProfile'].includes(command.type)) {
      throw new Error('paused worker cannot access LINE');
    }
    switch (command.type) {
      case 'setSecretState':
        if (this.#loginAttemptId && this.#loginAttemptId !== command.loginAttemptId) {
          throw new Error('login attempt mismatch');
        }
        if (this.#loginInFlight) throw new Error('login in progress');
        if (this.#secretRestoreInFlight) throw new Error('secret restore in progress');
        this.#loginAttemptId = command.loginAttemptId;
        this.#secretRestoreInFlight = true;
        try {
          await this.#withCredentialSwap(async (owner) => {
            const secrets = structuredClone(command.secrets);
            await this.#transport.installSecrets(secrets);
            if (owner !== this.#transportGeneration) throw new Error('LINE credential operation is stale');
            this.#secrets = secrets;
          });
        }
        finally { this.#secretRestoreInFlight = false; }
        return;
      case 'loginQr':
      case 'loginToken': {
        if (this.#loginAttemptId && this.#loginAttemptId !== command.loginAttemptId) throw new Error('login attempt mismatch');
        if (this.#loginInFlight) throw new Error('login in progress');
        if (this.#secretRestoreInFlight) throw new Error('secret restore in progress');
        this.#loginAttemptId = command.loginAttemptId;
        this.#loginInFlight = true;
        this.#startupSync = true;
        this.#startupFinalBatchId = undefined;
        this.#lastStartupCompleteBatchId = undefined;
        try {
          await this.#emit({ type: 'status', ...this.#identity(), state: 'connecting', message: null });
          let loginStage = 'credential_swap';
          try {
            const result = await this.#withCredentialSwap(() => command.type === 'loginQr'
              ? this.#transport.loginQr()
              : this.#transport.loginToken(this.#requireToken()), null);
            if (this.#stopped) return;
            loginStage = 'login_event';
            this.#ownMid = result.ownMid;
            this.#resetCatalogRefresh();
            await this.#emit({ type: 'login', ...this.#identity(), loginAttemptId: command.loginAttemptId,
              ownMid: result.ownMid, displayName: result.displayName, ...(result.picturePath === undefined ? {} : { picturePath: result.picturePath }) });
            await this.#emit({ type: 'status', ...this.#identity(), state: 'ready', message: null });
            this.#startCatalogRefresh();
          } catch (error) {
            // A diagnostic tag only; the first tag (from the transport) stays.
            tagLoginStage(error, loginStage);
            throw error;
          }
        } finally { this.#loginInFlight = false; }
        return;
      }
      case 'poll':
        if (!this.#ownMid || this.#loginInFlight || this.#secretRestoreInFlight) return;
        this.#catalogRefreshPollTick();
        this.#detailRefreshPollTick();
        await this.#withTransportCall(() => this.#poll());
        return;
      case 'ackBatch':
        // Main may ack a re-emitted copy of a batch it already acknowledged; that repeat is already done.
        if (this.#lastAckedBatch?.batchId === command.batchId && this.#cursor!.pendingBatch?.batchId !== command.batchId
          && cursorsEqual(command.cursorAfter, this.#cursor!.durableCursor)) {
          if (command.startupComplete && this.#lastStartupCompleteBatchId === command.batchId) {
            await this.#emit({ type: 'startupSyncComplete', ...this.#identity(), batchId: command.batchId });
          }
          return;
        }
        const startupFinal = this.#startupFinalBatchId === command.batchId;
        if (command.startupComplete && !startupFinal) throw new Error('Startup completion requires the final startup batch');
        this.#cursor!.acknowledge({ accountId: binding.accountId, batchId: command.batchId,
          cursorBefore: this.#cursor!.pendingBatch?.cursorBefore ?? this.#cursor!.durableCursor,
          cursorAfter: command.cursorAfter });
        this.#lastAckedBatch = { batchId: command.batchId };
        if (command.startupComplete && startupFinal) {
          this.#startupSync = false;
          this.#startupFinalBatchId = undefined;
          this.#lastStartupCompleteBatchId = command.batchId;
          await this.#emit({ type: 'startupSyncComplete', ...this.#identity(), batchId: command.batchId });
        } else if (startupFinal) this.#startupFinalBatchId = undefined;
        return;
      case 'history':
        await this.#withTransportCall(() => this.#history(command));
        return;
      case 'chatResourceRead':
        await this.#withTransportCall(() => this.#chatResourceRead(command));
        return;
      case 'refreshOwnProfile': {
        const identity = this.#identity();
        if (this.#profileReadInFlight) {
          await this.#emit({ type: 'ownProfileResult', ...identity, requestId: command.requestId, ok: false, error: 'PROFILE_READ_BUSY' });
          return;
        }
        this.#profileReadInFlight = true;
        try {
          if (!this.#ownMid || !this.#transport.refreshOwnProfile) throw new Error('PROFILE_READ_UNAVAILABLE');
          const profile = await this.#withTransportCall(() => this.#transport.refreshOwnProfile!());
          if (this.#stopped || this.#revoked || profile.ownMid !== this.#ownMid) throw new Error('PROFILE_MISMATCH');
          await this.#emit({ type: 'ownProfileResult', ...identity, requestId: command.requestId, ok: true, error: null,
            ownMid: profile.ownMid, displayName: profile.displayName, ...(profile.picturePath === undefined ? {} : { picturePath: profile.picturePath }) });
        } catch (error) {
          await this.#emit({ type: 'ownProfileResult', ...this.#identity(), requestId: command.requestId, ok: false,
            error: isLineServerRejection(error) ? error.code
              : error instanceof Error && ['PROFILE_READ_UNAVAILABLE', 'PROFILE_MISMATCH'].includes(error.message) ? error.message : 'PROFILE_READ_FAILED' });
        } finally { this.#profileReadInFlight = false; }
        return;
      }
      case 'logout': {
        const identity = this.#identity();
        let ok = false;
        let error: 'LINE_LOGOUT_FAILED' | 'LINE_AUTH_INVALIDATED' | null = null;
        if (this.#authInvalidated) {
          ok = false;
          error = 'LINE_AUTH_INVALIDATED';
        } else if (!this.#ownMid || !this.#transport.logoutServer) {
          error = 'LINE_LOGOUT_FAILED';
        } else {
          const controller = new AbortController();
          const deadline = setTimeout(() => controller.abort(new Error('LINE_LOGOUT_DEADLINE_EXCEEDED')), LOGOUT_DEADLINE_MS);
          try {
            this.#transportQuarantined = true;
            await this.#waitForTransportDrain(controller.signal);
            await this.#transport.logoutServer(controller.signal);
            if (this.#authInvalidated) error = 'LINE_AUTH_INVALIDATED';
            else ok = true;
          } catch {
            error = 'LINE_LOGOUT_FAILED';
          } finally {
            clearTimeout(deadline);
            if (!ok) this.#transportQuarantined = false;
          }
        }
        await this.#emit({ type: 'logoutResult', ...identity, requestId: command.requestId, ok, error });
        return;
      }
      case 'cancelChatResourceRead':
        this.#activeChatResourceReads.get(command.requestId)?.abort(new Error('Chat resource request cancelled'));
        return;
      case 'downloadAttachment':
        await this.#withTransportCall(() => this.#download(command));
        return;
      case 'cancelAttachmentDownload':
        await this.#cancelAttachment(command);
        return;
      case 'sendText':
      case 'manualSendText':
        if (this.#currentSend) {
          await this.#emit({ type: 'sendResult', ...this.#identity(), requestId: command.requestId,
            status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
          return;
        }
        this.#currentSend = this.#send(command);
        try { await this.#currentSend; } finally { this.#currentSend = undefined; }
        return;
      case 'sendMedia':
        if (this.#currentSend) {
          await this.#emit({ type: 'sendResult', ...this.#identity(), requestId: command.requestId,
            operationId: command.operationId, attemptId: command.attemptId,
            status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
          return;
        }
        this.#currentSend = this.#sendMedia(command);
        try { await this.#currentSend; } finally { this.#currentSend = undefined; }
        return;
      case 'reactMessage':
        await this.#reactMessage(command);
        return;
      case 'unsendMessage':
        await this.#unsendMessage(command);
        return;
      case 'checkFriendRelation':
        await this.#checkFriendRelation(command);
        return;
      case 'addFriendByMid':
        await this.#addFriend(command);
        return;
      case 'revokeControl':
        if (this.#currentSend) await this.#currentSend;
        await this.#emit({ type: 'modeAck', ...this.#identity(), mode: 'MONITOR_ONLY', drained: true });
        return;
      case 'stop':
        if (this.#currentSend) await this.#currentSend;
        await this.#emit({ type: 'status', ...this.#identity(), state: 'stopped', message: null });
        return;
      default:
        await this.#emit({ type: 'error', ...this.#identity(), code: 'WORKER_OPERATION_FAILED',
          message: 'worker command is not implemented', retryable: false,
          diagnostic: { operation: 'unknown', stage: 'dispatch', category: 'unsupported', recovery: 'check_configuration', outcome: 'not_started' } });
    }
  }

  async #withTransportCall<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#authInvalidated || this.#transportQuarantined || this.#credentialSwapPending) throw new Error('LINE transport owner is changing');
    this.#activeTransportCalls += 1;
    try { return await operation(); }
    finally {
      this.#activeTransportCalls -= 1;
      if (this.#activeTransportCalls === 0) for (const resolve of this.#transportDrainWaiters.splice(0)) resolve();
    }
  }

  async #waitForTransportDrain(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('LINE_LOGOUT_ABORTED');
    if (this.#activeTransportCalls === 0) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const index = this.#transportDrainWaiters.indexOf(waiter);
        if (index >= 0) this.#transportDrainWaiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('LINE_LOGOUT_ABORTED'));
      };
      this.#transportDrainWaiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async #withCredentialSwap<T>(operation: (owner: number) => Promise<T>, deadlineMs: number | null = 10_000): Promise<T> {
    if (this.#credentialSwapPending || this.#transportQuarantined) throw new Error('LINE transport owner is unavailable');
    this.#credentialSwapPending = true;
    try {
      if (this.#activeTransportCalls > 0) {
        await new Promise<void>((resolve, reject) => {
          const waiter = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            const index = this.#transportDrainWaiters.indexOf(waiter);
            if (index >= 0) this.#transportDrainWaiters.splice(index, 1);
            reject(new Error('LINE transport owner drain deadline exceeded'));
          }, 5_000);
          this.#transportDrainWaiters.push(waiter);
        });
      }
      if (this.#activeTransportCalls > 0) throw new Error('LINE transport owner drain deadline exceeded');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const owner = ++this.#transportGeneration;
      const task = Promise.resolve().then(() => operation(owner));
      void task.then(() => { settled = true; }, () => { settled = true; });
      try {
        return deadlineMs === null ? await task : await Promise.race([task, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('LINE credential operation deadline exceeded')), deadlineMs);
        })]);
      } catch (error) {
        if (!settled) {
          this.#transportQuarantined = true;
          this.#transportGeneration += 1;
          void this.#emit({ type: 'status', ...this.#identity(), state: 'degraded', message: null })
            .catch(() => { /* quarantine remains authoritative even if the status sink is unavailable */ });
        }
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    } finally { this.#credentialSwapPending = false; }
  }

  #requireToken(): string {
    if (!this.#secrets.token) throw new Error('secret token is unavailable');
    return this.#secrets.token;
  }

  #resetCatalogRefresh(): void {
    this.#catalogRefreshGeneration += 1;
    this.#catalogRetryAttempt = 0;
    this.#catalogRetryAtTick = this.#catalogPollTicks;
    this.#catalogRequested = false;
    this.#catalogFailureReported = false;
    this.#catalogRefreshComplete = false;
    this.#knownChatIds.clear();
    this.#pendingDetailIds.clear();
    this.#detailRetryAttempt = 0;
    this.#detailRetryAtTick = this.#catalogPollTicks;
  }

  #noteUnknownChats(envelopes: readonly Readonly<{ chatType: string; chatId: string }>[]): void {
    for (const { chatType, chatId } of envelopes) {
      if (chatType !== 'group' && chatType !== 'room') continue;
      if (this.#knownChatIds.has(chatId) || this.#pendingDetailIds.has(chatId)) continue;
      if (this.#pendingDetailIds.size >= CHAT_DETAIL_BATCH_LIMIT) return;
      this.#pendingDetailIds.add(chatId);
    }
  }

  #detailRefreshPollTick(): void {
    if (!this.#catalogRefreshComplete || this.#catalogRefreshFlight || this.#detailFlight || !this.#ownMid
      || this.#revoked || this.#authInvalidated || !this.#transport.listConversationDetails) return;
    if (this.#catalogPollTicks < this.#detailRetryAtTick) return;
    for (const chatId of this.#pendingDetailIds) if (this.#knownChatIds.has(chatId)) this.#pendingDetailIds.delete(chatId);
    const chatIds = [...this.#pendingDetailIds].slice(0, CHAT_DETAIL_BATCH_LIMIT);
    if (chatIds.length === 0) return;
    const generation = this.#catalogRefreshGeneration;
    const receiveGeneration = this.#receiveGeneration;
    const transportGeneration = this.#transportGeneration;
    const listDetails = this.#transport.listConversationDetails.bind(this.#transport);
    let task!: Promise<void>;
    task = (async () => {
      try {
        const conversations = await this.#withTransportCall(() => listDetails(chatIds));
        if (!this.#ownsCatalogRefresh(generation, receiveGeneration, transportGeneration)) return;
        if (conversations.length > 0) await this.#emit({ type: 'conversationCatalog', ...this.#identity(), conversations });
        if (!this.#ownsCatalogRefresh(generation, receiveGeneration, transportGeneration)) return;
        // Ids that LINE did not return count as known too, so this session does not ask again.
        for (const chatId of chatIds) { this.#knownChatIds.add(chatId); this.#pendingDetailIds.delete(chatId); }
        for (const item of conversations) this.#knownChatIds.add(item.chatId);
        this.#detailRetryAttempt = 0;
      } catch {
        // Ids stay pending; no status event for detail failures.
        if (!this.#ownsCatalogRefresh(generation, receiveGeneration, transportGeneration)) return;
        this.#detailRetryAttempt = Math.min(this.#detailRetryAttempt + 1, 6);
        this.#detailRetryAtTick = this.#catalogPollTicks + [1, 2, 4, 8, 16, 32][this.#detailRetryAttempt - 1]!;
      } finally {
        if (this.#detailFlight === task) this.#detailFlight = undefined;
      }
    })();
    this.#detailFlight = task;
    void task.catch(() => undefined);
  }

  #catalogRefreshPollTick(): void {
    this.#catalogPollTicks += 1;
    if (this.#catalogRefreshComplete || !this.#ownMid || this.#revoked || this.#authInvalidated) return;
    if (this.#catalogRefreshFlight) {
      this.#catalogRequested = true;
      return;
    }
    if (this.#catalogRequested && this.#catalogPollTicks >= this.#catalogRetryAtTick) this.#startCatalogRefresh();
  }

  #startCatalogRefresh(): void {
    if (this.#catalogRefreshComplete || !this.#ownMid || this.#revoked || this.#authInvalidated) return;
    if (this.#catalogRefreshFlight) {
      this.#catalogRequested = true;
      return;
    }
    const generation = this.#catalogRefreshGeneration;
    const receiveGeneration = this.#receiveGeneration;
    const transportGeneration = this.#transportGeneration;
    this.#catalogRequested = false;
    let task!: Promise<void>;
    task = (async () => {
      try {
        const conversations = await this.#withTransportCall(() => this.#transport.listConversations());
        if (!this.#ownsCatalogRefresh(generation, receiveGeneration, transportGeneration)) return;
        if (this.#catalogFailureReported) {
          this.#catalogFailureReported = false;
          await this.#emit({ type: 'catalogRefreshStatus', ...this.#identity(), state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' });
        }
        if (!this.#ownsCatalogRefresh(generation, receiveGeneration, transportGeneration)) return;
        await this.#emit({ type: 'conversationCatalog', ...this.#identity(), conversations });
        this.#catalogRefreshComplete = true;
        this.#catalogRetryAttempt = 0;
        for (const item of conversations) this.#knownChatIds.add(item.chatId);
      } catch (error) {
        if (!this.#ownsCatalogRefresh(generation, receiveGeneration, transportGeneration)) return;
        this.#catalogRetryAttempt = Math.min(this.#catalogRetryAttempt + 1, 6);
        const retryDelay = [1, 2, 4, 8, 16, 32][this.#catalogRetryAttempt - 1]!;
        this.#catalogRetryAtTick = this.#catalogPollTicks + retryDelay;
        this.#catalogRequested = true;
        if (!this.#catalogFailureReported) {
          this.#catalogFailureReported = true;
          await this.#emit({ type: 'catalogRefreshStatus', ...this.#identity(), state: 'degraded', code: 'CATALOG_REFRESH_FAILED',
            ...(isLineServerRejection(error) ? { serverError: error.code } : {}) }).catch(() => undefined);
        }
      } finally {
        if (this.#catalogRefreshFlight === task) this.#catalogRefreshFlight = undefined;
      }
    })();
    this.#catalogRefreshFlight = task;
    void task.catch(() => undefined);
  }

  #ownsCatalogRefresh(generation: number, receiveGeneration: number, transportGeneration: number): boolean {
    return generation === this.#catalogRefreshGeneration && receiveGeneration === this.#receiveGeneration
      && transportGeneration === this.#transportGeneration && !this.#revoked && !this.#authInvalidated;
  }

  #identity(): ControlLease & Partial<Pick<InitCommand, 'transportOwnerId' | 'transportGeneration' | 'writeGrantVersion'>> {
    const binding = this.#binding;
    if (!binding) throw new Error('worker is not initialized');
    return { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch,
      ...(binding.transportOwnerId === undefined ? {} : { transportOwnerId: binding.transportOwnerId }),
      ...(binding.transportGeneration === undefined ? {} : { transportGeneration: binding.transportGeneration }),
      ...(binding.writeGrantVersion === undefined ? {} : { writeGrantVersion: binding.writeGrantVersion }) };
  }
  #queueEvent(value: unknown): void {
    if (this.#eventFailure) throw this.#eventFailure;
    if (this.#pendingEvents >= 64) {
      this.#eventFailure = Object.assign(new Error('worker event queue is full'), { code: 'WORKER_EVENT_QUEUE_FULL' });
      throw this.#eventFailure;
    }
    const event = LineWorkerEventSchema.parse(value);
    this.#pendingEvents += 1;
    this.#eventTail = this.#eventTail.then(async () => {
      if (!this.#eventFailure) await this.#emitEvent(event);
    }).catch((error: unknown) => {
      this.#eventFailure = Object.assign(new Error('private event sink failed'), { code: 'WORKER_EVENT_SINK_FAILED' });
    }).finally(() => { this.#pendingEvents -= 1; });
  }
  async #emit(value: unknown): Promise<void> {
    const event = LineWorkerEventSchema.parse(value);
    await this.#emitEvent(event);
  }
  #emitLoginEvent(type: 'qr' | 'pin', value: { code: string } | { pin: string }): void {
    if (!this.#loginAttemptId || !this.#binding) return;
    try { this.#queueEvent({ type, ...this.#identity(), loginAttemptId: this.#loginAttemptId, ...value }); }
    catch (error) { tagLoginStage(error, 'login_event_queue'); this.#eventFailure = error instanceof Error ? error : new Error('private event queue failed'); }
  }
  #emitSecretRotation(): void {
    if (!this.#loginAttemptId || !this.#binding) return;
    try {
      this.#queueEvent({ type: 'secretRotation', ...this.#identity(), loginAttemptId: this.#loginAttemptId,
        secrets: structuredClone(this.#secrets) });
    } catch (error) { tagLoginStage(error, 'secret_export'); this.#eventFailure = error instanceof Error ? error : new Error('private event queue failed'); }
  }
  async #poll(): Promise<void> {
    if (this.#polling || this.#authInvalidated) return;
    const pending = this.#cursor!.pendingBatch;
    if (pending) {
      await this.#emit({ type: 'batch', ...this.#identity(), ...pending,
        startupSync: this.#startupSync, startupFinal: this.#startupSync && this.#startupFinalBatchId === pending.batchId });
      return;
    }
    this.#polling = true;
    const receiveGeneration = this.#receiveGeneration;
    try {
      const before = this.#cursor!.durableCursor;
      let result: SyncResult;
      try {
        result = await this.#transport.sync(before);
        if (receiveGeneration !== this.#receiveGeneration) return;
        const recovered = this.#syncFailures >= 5;
        this.#syncFailures = 0;
        if (recovered) await this.#emit({ type: 'status', ...this.#identity(), state: 'ready', message: null });
      } catch (error) {
        this.#syncFailures += 1;
        if (isLineServerRejection(error)) await this.#emit({ type: 'error', ...this.#identity(),
          code: error.code, message: error.code, retryable: false,
          diagnostic: { operation: 'poll', stage: 'response', category: 'denied', recovery: 'none',
            upstreamCode: error.upstreamCode } });
        if (this.#syncFailures === 5) {
          await this.#emit({ type: 'status', ...this.#identity(), state: 'degraded',
            message: isLineServerRejection(error) ? error.message : null });
        }
        return;
      }
      // Liveness record only: it must not change the poll result, so an emit failure is ignored.
      if (Date.now() - this.#lastSyncConfirmedAt >= SYNC_CONFIRMED_INTERVAL_MS) {
        this.#lastSyncConfirmedAt = Date.now();
        await this.#emit({ type: 'syncConfirmed', ...this.#identity() }).catch(() => undefined);
      }
      if (result.operations.length > 100) throw new Error('sync response exceeds bounded batch limit');
      const rawOperationCount = result.rawOperationCount ?? result.operations.length;
      if (!Number.isSafeInteger(rawOperationCount) || rawOperationCount < 0) throw new Error('sync response has invalid raw operation count');
      const readReceipts = result.readReceipts ?? [];
      if (readReceipts.length > 500) throw new Error('sync response exceeds bounded read receipt limit');
      const unsends = result.unsends ?? [];
      if (unsends.length > 500) throw new Error('sync response exceeds bounded unsend limit');
      if (result.operations.length === 0 && readReceipts.length === 0 && unsends.length === 0 && JSON.stringify(before) === JSON.stringify(result.cursorAfter)
        && !this.#startupSync) return;
      const context = { accountId: this.#binding!.accountId, ownMid: this.#ownMid ?? '',
        source: 'live' as const, cursor: null };
      const envelopes = result.operations.map((item) => {
        if (typeof item === 'object' && item !== null && 'operation' in item) {
          const tagged = item as { operation: unknown; source?: 'live' | 'history'; decryptionError?: DecryptionFailure };
          return normalizeOperation(tagged.operation, { ...context, source: tagged.source ?? context.source }, tagged.decryptionError);
        }
        return normalizeOperation(item, context);
      });
      this.#noteUnknownChats(envelopes);
      const batch = this.#cursor!.stage(randomUUID(), result.cursorAfter, envelopes as unknown as readonly JsonValue[], readReceipts, unsends);
      const startupFinal = this.#startupSync && rawOperationCount < 100 && result.hasMoreStartupItems !== true;
      if (startupFinal) this.#startupFinalBatchId = batch.batchId;
      await this.#emit({ type: 'batch', ...this.#identity(), ...batch,
        startupSync: this.#startupSync, startupFinal: this.#startupSync && startupFinal });
    } finally {
      this.#polling = false;
    }
  }
  async #history(command: Extract<LineWorkerCommand, { type: 'history' }>): Promise<void> {
    const cursor = command.cursor === null ? null : decodeHistoryCursor(command.cursor);
    if (cursor && (cursor.accountId !== command.accountId || cursor.chatType !== command.chatType ||
      cursor.chatId !== command.chatId)) throw new Error('history cursor conversation mismatch');
    const messages = await this.#transport.history({ chatType: command.chatType, chatId: command.chatId },
      cursor, command.limit);
    if (messages.length > command.limit) throw new Error('history response exceeds requested limit');
    const envelopes = messages.map((message) => normalizeOperation({ revision: (message as { id?: unknown }).id, message },
      { accountId: command.accountId, ownMid: this.#ownMid ?? '', source: 'history', cursor: command.cursor }));
    const last = messages.at(-1) as { id?: unknown; deliveredTime?: unknown; createdTime?: unknown } | undefined;
    const nextCursor = last === undefined ? null : encodeHistoryCursor({ version: 1,
      accountId: command.accountId, chatType: command.chatType, chatId: command.chatId,
      messageId: String(last.id), deliveredTime: String(last.deliveredTime ?? last.createdTime),
    });
    await this.#emit({ type: 'historyResult', ...this.#identity(), chatType: command.chatType,
      chatId: command.chatId, requestId: command.requestId, nextCursor, envelopes });
  }
  async #chatResourceRead(command: Extract<LineWorkerCommand, { type: 'chatResourceRead' }>): Promise<void> {
    const identity = this.#identity();
    const base = { type: 'chatResourceResult' as const, ...identity, chatType: command.chatType, chatId: command.chatId,
      requestId: command.requestId, action: command.action };
    const fail = async (error: string, responseCode?: number | 'missing' | 'non_numeric', failureKind?: ReturnType<typeof safeChatResourceFailureDetails>['failureKind'],
      upstreamStatus?: number, upstreamCode?: number | 'missing' | 'non_numeric') => this.#emit({ ...base, ok: false, error,
      ...(typeof responseCode === 'number' && Number.isFinite(responseCode) && Math.abs(responseCode) <= 1_000_000_000
        || responseCode === 'missing' || responseCode === 'non_numeric' ? { responseCode } : {}),
      ...(failureKind ? { failureKind } : {}), ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      ...(upstreamCode === undefined ? {} : { upstreamCode }) });
    if (this.#stopped || this.#revoked || this.#authInvalidated || this.#binding?.mode === 'PAUSED') {
      await fail('WORKER_NOT_ACTIVE'); return;
    }
    if (!this.#ownMid) { await fail('NOT_LOGGED_IN'); return; }
    if (!this.#transport.readChatResource) { await fail('UNSUPPORTED'); return; }
    if (this.#activeChatResourceReads.size >= 4 || this.#activeChatResourceReads.has(command.requestId)) { await fail('QUEUE_FULL'); return; }
    const controller = new AbortController();
    this.#activeChatResourceReads.set(command.requestId, controller);
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Chat resource request timed out'), { code: 'TIMEOUT' })), command.timeoutMs);
    try {
      const value = await this.#transport.readChatResource(command, { signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (command.action === 'listAlbums') {
        const albums = (value.albums ?? []).filter((album) => typeof album === 'object' && album !== null &&
          (album as { chatId?: unknown }).chatId === command.chatId).slice(0, command.limit ?? 50);
        let result: ReturnType<typeof LineWorkerEventSchema.parse>;
        try { result = LineWorkerEventSchema.parse({ ...base, ok: true, error: null, albums, nextCursor: value.nextCursor ?? null }); }
        catch { await fail('response_validation'); return; }
        await this.#emit(result);
      } else {
        const payload = { ...base, ok: true, error: null, ...value };
        let result: ReturnType<typeof LineWorkerEventSchema.parse>;
        try { result = LineWorkerEventSchema.parse(payload); }
        catch { await fail('response_validation'); return; }
        if (('notes' in result && (result.notes?.length ?? 0) > (command.limit ?? 50)) ||
          ('albums' in result && (result.albums?.length ?? 0) > (command.limit ?? 50)) ||
          ('photos' in result && (result.photos?.length ?? 0) > (command.limit ?? 50))) { await fail('response_validation'); return; }
        await this.#emit(result);
      }
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason as { code?: unknown } | undefined : undefined;
      if (reason?.code === 'TIMEOUT') await fail('TIMEOUT');
      else if (controller.signal.aborted) await fail('CANCELLED');
      else if (isChatResourceUnsupported(error)) await fail('UNSUPPORTED');
      else if (isChatResourceFailure(error)) await fail(error.category,
        error.category === 'response_code_invalid' ? error.responseCode : undefined,
        error.failureKind ?? safeChatResourceFailureDetails(error).failureKind, error.upstreamStatus, error.upstreamCode);
      else {
        const details = safeChatResourceFailureDetails(error);
        await fail('unknown', undefined, details.failureKind, details.upstreamStatus, details.upstreamCode);
      }
    } finally {
      clearTimeout(timeout);
      if (this.#activeChatResourceReads.get(command.requestId) === controller) this.#activeChatResourceReads.delete(command.requestId);
    }
  }
  async #download(command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>): Promise<void> {
    const identity = this.#identity();
    const conversation = { accountId: identity.accountId, chatType: command.chatType, chatId: command.chatId };
    const deadline = Date.now() + command.timeoutMs;
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    this.#activeAttachments.set(command.attemptToken, { attachmentId: command.attachmentId, controller, finished, finish });
    const timeoutError = Object.assign(new Error('Attachment download timed out'), { code: 'TIMEOUT' });
    const timer = setTimeout(() => controller.abort(timeoutError), command.timeoutMs);
    let acquired = false;
    let stage: 'PREPARE' | 'LINE_DOWNLOAD' | 'STORE' = 'PREPARE';
    try {
      await this.#acquireDownload(controller.signal);
      acquired = true;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!this.#attachmentRoot) throw new Error('attachment root unavailable');
      await mkdir(this.#attachmentRoot, { recursive: true });
      const volume = await statfs(this.#attachmentRoot);
      if (Number(volume.bavail) * Number(volume.bsize) < this.#minFreeBytes) throw new Error('disk watermark reached');
      stage = 'LINE_DOWNLOAD';
      if (!this.#ownMid) throw new SafeAttachmentError('ATTACHMENT_METADATA_INVALID');
      const identity: AttachmentDownloadIdentity = { accountId: command.accountId, chatType: command.chatType,
        chatId: command.chatId, ownMid: this.#ownMid, messageId: command.messageId,
        kind: command.kind, externalAttachmentId: command.externalAttachmentId };
      validateAttachmentMessage(command.lineMessage, identity, command.maxBytes);
      const download = await this.#transport.download(command.kind, command.messageId,
        command.externalAttachmentId, command.lineMessage, { signal: controller.signal, maxBytes: command.maxBytes, identity });
      if (controller.signal.aborted) throw controller.signal.reason;
      const safeName = (name: string | null | undefined): string | undefined => {
        if (name == null) return undefined;
        try { return sanitizeAttachmentFilename(name); } catch { return undefined; }
      };
      const namedByLine = safeName(download.name);
      let originalFileName = namedByLine ?? safeName(command.originalFileName) ?? 'attachment.blob';
      let source = download.source;
      if (deadline - Date.now() <= 0) throw timeoutError;
      stage = 'STORE';
      // LINE image messages have no file name. The desktop sends the placeholder attachment.bin for them.
      // Choose the extension from the first bytes so that the stored file opens with the correct program.
      if (command.kind === 'image' && namedByLine === undefined && (originalFileName === 'attachment.bin' || originalFileName === 'attachment.blob')) {
        const peeked = await peekAttachmentSource(source, IMAGE_SNIFF_PREFIX_BYTES, controller.signal);
        source = peeked.source;
        originalFileName = fallbackAttachmentFileName(peeked.prefix);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timeoutError;
      const stored = await storeAttachment({ root: this.#attachmentRoot,
        identity: { ...conversation, messageId: command.messageId,
          externalAttachmentId: command.externalAttachmentId },
        occurredAt: command.occurredAt, originalFileName,
        ...((command.senderId !== undefined) ? { sender: { id: command.senderId, displayName: command.senderDisplayName ?? null } } : {}),
        maxBytes: command.maxBytes, timeoutMs: remainingMs, signal: controller.signal,
        source,
      }, this.#attachmentRuntime);
      await this.#emit({ type: 'attachmentResult', ...this.#identity(), ...conversation,
        attachmentId: command.attachmentId, attemptToken: command.attemptToken, status: 'ready',
        relativePath: stored.managedRelativePath.replaceAll('\\', '/'),
        sha256: stored.sha256, sizeBytes: stored.size, name: stored.sanitizedDisplayFileName });
    } catch (error) {
      const serverRejection = error instanceof SafeAttachmentError && error.serverErrorCode?.startsWith('LINE_TALK_')
        ? talkServerError(error.serverErrorCode.slice('LINE_TALK_'.length)) : null;
      await this.#emit({ type: 'attachmentResult', ...this.#identity(), ...conversation,
        attachmentId: command.attachmentId, attemptToken: command.attemptToken, status: 'failed',
        error: attachmentFailureCode(error, stage, controller.signal.aborted),
        ...(serverRejection && error instanceof SafeAttachmentError && error.upstreamCode === serverRejection.upstreamCode
          && !controller.signal.aborted
          ? { serverErrorCode: serverRejection.code, upstreamCode: serverRejection.upstreamCode } : {}) });
    } finally {
      clearTimeout(timer);
      if (acquired) this.#releaseDownload();
      const active = this.#activeAttachments.get(command.attemptToken);
      if (active?.attachmentId === command.attachmentId) this.#activeAttachments.delete(command.attemptToken);
      finish();
    }
  }

  async #cancelAttachment(command: Extract<LineWorkerCommand, { type: 'cancelAttachmentDownload' }>): Promise<void> {
    const active = this.#activeAttachments.get(command.attemptToken);
    const matches = active?.attachmentId === command.attachmentId;
    if (matches) {
      active.controller.abort(new Error('Attachment attempt cancelled'));
      await active.finished;
    }
    await this.#emit({ type: 'attachmentCancelAck', ...this.#identity(), attachmentId: command.attachmentId,
      attemptToken: command.attemptToken, cancelled: matches });
  }
  async #acquireDownload(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (this.#activeDownloads < 2) { this.#activeDownloads += 1; return; }
    if (this.#downloadWaiters.length >= 16) throw new Error('attachment queue is full');
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: () => {
        const index = this.#downloadWaiters.indexOf(waiter);
        if (index >= 0) this.#downloadWaiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Attachment download aborted'));
      } };
      this.#downloadWaiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }
  #releaseDownload(): void {
    const next = this.#downloadWaiters.shift();
    if (next) { next.signal.removeEventListener('abort', next.onAbort); next.resolve(); }
    else this.#activeDownloads -= 1;
  }
  async #send(command: Extract<LineWorkerCommand, { type: 'sendText' | 'manualSendText' }>): Promise<void> {
    const identity = this.#identity();
    const owned = this.#binding!.transportOwnerId !== undefined;
    const permit = command.effectPermit;
    const validEffectPermit = !owned || (command.transportOwnerId === identity.transportOwnerId &&
      command.transportGeneration === identity.transportGeneration && command.writeGrantVersion === identity.writeGrantVersion &&
      typeof command.operationId === 'string' && command.operationId.length > 0 &&
      typeof command.attemptId === 'string' && command.attemptId.length > 0 &&
      typeof permit === 'string' && permit.length > 0 && !this.#usedEffectPermits.has(permit) && this.#usedEffectPermits.size < 4096);
    if (isLocalAgentRoom(command)) {
      await this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
        operationId: command.operationId, attemptId: command.attemptId,
        status: 'failed', messageId: null, error: 'LOCAL_ROUTE_DENIED' });
      return;
    }
    const manual = command.type === 'manualSendText';
    const permittedMode = this.#binding!.mode === 'ACTIVE_CONTROL' || (manual && this.#binding!.mode === 'MONITOR_ONLY');
    if (!validEffectPermit || !permittedMode || this.#revoked || this.#sending ||
      this.#credentialSwapPending || this.#transportQuarantined) {
      await this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
        operationId: command.operationId, attemptId: command.attemptId,
        status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
      return;
    }
    this.#sending = true;
    try {
      const initialLeaseValid = await this.#validateLease(identity);
      if (this.#revoked || !permittedMode || !initialLeaseValid ||
        this.#credentialSwapPending || this.#transportQuarantined) {
        await this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
          operationId: command.operationId, attemptId: command.attemptId,
          status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
        return;
      }
      const leaseValid = await this.#validateLease(identity);
      if (this.#revoked || !permittedMode || !leaseValid ||
        this.#credentialSwapPending || this.#transportQuarantined) {
        await this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
          operationId: command.operationId, attemptId: command.attemptId,
          status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
        return;
      }
      if (owned && permit) this.#usedEffectPermits.add(permit);
      const result = await this.#withTransportCall(() => this.#transport.send({ chatType: command.chatType, chatId: command.chatId },
        command.text, command.replyToMessageId, identity, manual, ...('mentions' in command && command.mentions?.length ? [command.mentions] as const : [])));
      await this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
        operationId: command.operationId, attemptId: command.attemptId,
        status: 'sent', messageId: result.messageId, error: null });
    } catch (error) {
      const denied = error instanceof EffectDeniedError;
      const rejected = isLineServerRejection(error);
      await this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
        operationId: command.operationId, attemptId: command.attemptId,
        status: denied || rejected ? 'failed' : 'unknown', messageId: null,
        error: denied ? 'SIDE_EFFECT_DENIED' : rejected ? error.code : 'TRANSPORT_OUTCOME_UNKNOWN' });
    } finally {
      this.#sending = false;
    }
  }

  async #readMediaFile(command: Extract<LineWorkerCommand, { type: 'sendMedia' }>): Promise<Buffer> {
    const cap = command.kind === 'image' ? MEDIA_IMAGE_MAX_BYTES : MEDIA_FILE_MAX_BYTES;
    if (command.sizeBytes > cap) throw new MediaFileError('FILE_UNREADABLE');
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(command.filePath, 'r'); } catch { throw new MediaFileError('FILE_UNREADABLE'); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new MediaFileError('FILE_UNREADABLE');
      if (stat.size !== command.sizeBytes) throw new MediaFileError('FILE_CHANGED');
      // One byte beyond the declared size detects a file that grew after the stat.
      const buffer = Buffer.allocUnsafe(command.sizeBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total !== command.sizeBytes) throw new MediaFileError('FILE_CHANGED');
      const bytes = buffer.subarray(0, total);
      if (createHash('sha256').update(bytes).digest('hex') !== command.sha256) throw new MediaFileError('FILE_CHANGED');
      return bytes;
    } catch (error) {
      throw error instanceof MediaFileError ? error : new MediaFileError('FILE_UNREADABLE');
    } finally { await handle.close().catch(() => undefined); }
  }

  async #sendMedia(command: Extract<LineWorkerCommand, { type: 'sendMedia' }>): Promise<void> {
    const identity = this.#identity();
    const result = (status: 'sent' | 'failed' | 'unknown', messageId: string | null, error: string | null, detail?: string) =>
      this.#emit({ type: 'sendResult', ...identity, requestId: command.requestId,
        operationId: command.operationId, attemptId: command.attemptId, status, messageId, error,
        ...(detail === undefined ? {} : { detail }) });
    const owned = this.#binding!.transportOwnerId !== undefined;
    const permit = command.effectPermit;
    const validEffectPermit = !owned || (command.transportOwnerId === identity.transportOwnerId &&
      command.transportGeneration === identity.transportGeneration && command.writeGrantVersion === identity.writeGrantVersion &&
      command.operationId.length > 0 && command.attemptId.length > 0 &&
      permit.length > 0 && !this.#usedEffectPermits.has(permit) && this.#usedEffectPermits.size < 4096);
    if (isLocalAgentRoom(command)) {
      await result('failed', null, 'LOCAL_ROUTE_DENIED');
      return;
    }
    const sendMedia = this.#transport.sendMedia?.bind(this.#transport);
    const manual = command.manualSend === true;
    const permittedMode = this.#binding!.mode === 'ACTIVE_CONTROL' || (manual && this.#binding!.mode === 'MONITOR_ONLY');
    if (!sendMedia || !validEffectPermit || !permittedMode || this.#revoked || this.#sending ||
      this.#credentialSwapPending || this.#transportQuarantined) {
      await result('failed', null, 'SIDE_EFFECT_DENIED');
      return;
    }
    this.#sending = true;
    try {
      const initialLeaseValid = await this.#validateLease(identity);
      if (this.#revoked || !permittedMode || !initialLeaseValid ||
        this.#credentialSwapPending || this.#transportQuarantined) {
        await result('failed', null, 'SIDE_EFFECT_DENIED');
        return;
      }
      let bytes: Buffer;
      try { bytes = await this.#readMediaFile(command); }
      catch (error) {
        await result('failed', null, error instanceof MediaFileError ? error.code : 'FILE_UNREADABLE');
        return;
      }
      const leaseValid = await this.#validateLease(identity);
      if (this.#revoked || !permittedMode || !leaseValid ||
        this.#credentialSwapPending || this.#transportQuarantined) {
        await result('failed', null, 'SIDE_EFFECT_DENIED');
        return;
      }
      if (owned) this.#usedEffectPermits.add(permit);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = this.#withTransportCall(() => sendMedia({ chatType: command.chatType, chatId: command.chatId },
        { kind: command.kind, bytes, fileName: command.fileName }, identity, manual));
      // The slot stays held until the real operation settles, even after a timeout result.
      const settled = operation.then(() => undefined, () => undefined);
      try {
        const outcome = await Promise.race([operation.then((value) => ({ value }), (error: unknown) => ({ error })),
          new Promise<{ timeout: true }>((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), command.timeoutMs); })]);
        if ('value' in outcome) await result('sent', outcome.value.messageId, null);
        else if ('timeout' in outcome) await result('unknown', null, 'TRANSPORT_OUTCOME_UNKNOWN');
        else if (outcome.error instanceof EffectDeniedError) await result('failed', null, 'SIDE_EFFECT_DENIED', mediaFailureDetail(outcome.error));
        else if (outcome.error instanceof MediaUploadFailedError) await result('failed', null, 'UPLOAD_FAILED', outcome.error.detail);
        else if (isLineServerRejection(outcome.error)) await result('failed', null, outcome.error.code, mediaFailureDetail(outcome.error));
        else await result('unknown', null, 'TRANSPORT_OUTCOME_UNKNOWN');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await settled;
      }
    } finally {
      this.#sending = false;
    }
  }

  async #reactMessage(command: Extract<LineWorkerCommand, { type: 'reactMessage' }>): Promise<void> {
    const identity = this.#identity();
    if (this.#binding!.mode !== 'ACTIVE_CONTROL' || this.#revoked || this.#authInvalidated
      || !await this.#validateLease(identity)) return;
    const prefix = { direct: 'u', group: 'c', room: 'r' }[command.chatType];
    if (!command.chatId.startsWith(prefix)) return;
    await this.#withTransportCall(() => this.#transport.react({ chatType: command.chatType, chatId: command.chatId },
      command.messageId, command.reaction, identity));
  }

  async #unsendMessage(command: Extract<LineWorkerCommand, { type: 'unsendMessage' }>): Promise<void> {
    const identity = this.#identity();
    const failed = async (status: 'failed' | 'unknown', error: string) => this.#emit({
      type: 'unsendResult', ...identity, chatType: command.chatType, chatId: command.chatId,
      requestId: command.requestId, messageId: command.messageId, status, error,
    });
    const binding = this.#binding!;
    if (!this.#transport.unsend || !this.#ownMid || (binding.mode !== 'ACTIVE_CONTROL' && binding.mode !== 'MONITOR_ONLY')
      || this.#revoked || this.#authInvalidated || this.#credentialSwapPending || this.#transportQuarantined || this.#sending) {
      await failed('failed', 'SIDE_EFFECT_DENIED'); return;
    }
    const prefix = { direct: 'u', group: 'c', room: 'r' }[command.chatType];
    if (!command.chatId.startsWith(prefix)) { await failed('failed', 'SIDE_EFFECT_DENIED'); return; }
    this.#sending = true;
    try {
      const leaseValid = await this.#validateLease(identity);
      if (this.#revoked || this.#authInvalidated || (binding.mode !== 'ACTIVE_CONTROL' && binding.mode !== 'MONITOR_ONLY')
        || !leaseValid || this.#credentialSwapPending || this.#transportQuarantined) {
        await failed('failed', 'SIDE_EFFECT_DENIED'); return;
      }
      await this.#withTransportCall(() => this.#transport.unsend!({ chatType: command.chatType, chatId: command.chatId }, command.messageId, identity));
      await this.#emit({ type: 'unsendResult', ...identity, chatType: command.chatType, chatId: command.chatId,
        requestId: command.requestId, messageId: command.messageId, status: 'unsent', error: null });
    } catch (error) {
      const denied = error instanceof EffectDeniedError;
      const rejected = isLineServerRejection(error);
      await failed(denied || rejected ? 'failed' : 'unknown', denied ? 'SIDE_EFFECT_DENIED'
        : rejected ? error.code : 'TRANSPORT_OUTCOME_UNKNOWN');
    } finally { this.#sending = false; }
  }

  async #relationAuthorized(): Promise<boolean> {
    const binding = this.#binding!;
    if (binding.mode !== 'ACTIVE_CONTROL' || this.#revoked || !this.#ownMid) return false;
    const valid = await this.#validateLease({ accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch });
    return valid && binding.mode === 'ACTIVE_CONTROL' && !this.#revoked && !!this.#ownMid;
  }

  #enqueueRelation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#relationPending >= 64) return Promise.reject(new Error('relation queue is full'));
    this.#relationPending += 1;
    const result = this.#relationTail.then(operation, operation);
    this.#relationTail = result.then(() => undefined, () => undefined).finally(() => { this.#relationPending -= 1; });
    return result;
  }

  async #withRelationDeadline<T>(operation: Promise<T>, timeoutValue: () => T, onTimeout: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((resolve) => { timer = setTimeout(() => {
        onTimeout(); resolve(timeoutValue());
      }, 30_000); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async #checkFriendRelation(command: Extract<LineWorkerCommand, { type: 'checkFriendRelation' }>): Promise<void> {
    const identity = this.#identity();
    let status: FriendRelation = 'unknown';
    let error: string | null = 'RELATION_OUTCOME_UNKNOWN';
    let failureDetails: Pick<FriendRelationDiagnostic, 'failureKind' | 'upstreamStatus' | 'upstreamCode'> = {};
    let expired = false;
    const controller = new AbortController();
    try {
      status = await this.#withRelationDeadline(this.#enqueueRelation(async () => {
        if (expired) return 'unknown';
        if (!await this.#relationAuthorized()) return 'unknown';
        if (expired) return 'unknown';
        const identity = { accountId: this.#binding!.accountId, workerInstanceId: this.#binding!.workerInstanceId,
          controlEpoch: this.#binding!.controlEpoch };
        if (this.#transport.checkFriendRelationDiagnostic) {
          const result = await this.#withTransportCall(() => this.#transport.checkFriendRelationDiagnostic!(command.targetMid, identity, controller.signal));
          error = result.error;
          if (result.status === 'unknown' && result.error === 'RELATION_DETAIL_RPC_FAILED') {
            failureDetails = { ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
              ...(result.upstreamStatus === undefined ? {} : { upstreamStatus: result.upstreamStatus }),
              ...(result.upstreamCode === undefined ? {} : { upstreamCode: result.upstreamCode }) };
          }
          return result.status;
        }
        const result = await this.#withTransportCall(() => this.#transport.checkFriendRelation(command.targetMid, identity, controller.signal));
        error = result === 'unknown' ? 'RELATION_OUTCOME_UNKNOWN' : null;
        return result;
      }), () => 'unknown', () => { expired = true; controller.abort(); });
      if (status === 'friend' && !await this.#relationAuthorized()) { status = 'unknown'; error = 'RELATION_BINDING_REVOKED'; }
    } catch { status = 'unknown'; error = this.#revoked ? 'RELATION_BINDING_REVOKED' : 'RELATION_OUTCOME_UNKNOWN'; }
    if (expired) error = 'RELATION_RESPONSE_TIMEOUT';
    if (this.#revoked) { status = 'unknown'; error = 'RELATION_BINDING_REVOKED'; }
    await this.#emit({ type: 'friendRelationResult', ...identity, requestId: command.requestId,
      targetMid: command.targetMid, status, error: status === 'unknown' ? error : null,
      ...(status === 'unknown' && error === 'RELATION_DETAIL_RPC_FAILED' ? failureDetails : {}) });
  }

  async #addFriend(command: Extract<LineWorkerCommand, { type: 'addFriendByMid' }>): Promise<void> {
    const existing = this.#addLedger.get(command.requestId);
    if (existing) {
      if (existing.targetMid === command.targetMid && existing.sourceChatMid === command.sourceChatMid) {
        const outcome = await existing.result;
        await this.#emit({ type: 'addFriendResult', ...this.#identity(), requestId: command.requestId,
          targetMid: command.targetMid, ...outcome });
      } else await this.#emit({ type: 'addFriendResult', ...this.#identity(), requestId: command.requestId,
        targetMid: command.targetMid, status: 'failed', error: 'REQUEST_ID_CONFLICT' });
      return;
    }
    const identity = this.#identity();
    if (this.#addLedger.size >= 1024) {
      await this.#emit({ type: 'addFriendResult', ...identity, requestId: command.requestId,
        targetMid: command.targetMid, status: 'failed', error: 'LEDGER_FULL' });
      return;
    }
    const started = { value: false };
    let expired = false;
    const controller = new AbortController();
    const result = Promise.resolve().then(async (): Promise<FriendAddResult> => {
      try {
        const queued = this.#enqueueRelation(async () => {
          if (expired) return { status: 'failed', error: 'NOT_STARTED' } as const;
          if (this.#binding!.mode !== 'ACTIVE_CONTROL' || this.#revoked) {
            return { status: 'failed', error: 'SIDE_EFFECT_DENIED' } as const;
          }
          if (!this.#ownMid) return { status: 'failed', error: 'NOT_READY' } as const;
          if (!await this.#relationAuthorized()) return { status: 'failed', error: 'SIDE_EFFECT_DENIED' } as const;
          if (expired) return { status: 'failed', error: 'NOT_STARTED' } as const;
          return safeFriendAddResult(await this.#withTransportCall(() => this.#transport.addFriendByMid(command.targetMid,
            { accountId: this.#binding!.accountId, workerInstanceId: this.#binding!.workerInstanceId,
              controlEpoch: this.#binding!.controlEpoch }, () => { started.value = true; }, controller.signal, command.sourceChatMid)));
        });
        return await this.#withRelationDeadline(queued,
          () => started.value ? { status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' } : { status: 'failed', error: 'NOT_STARTED' },
          () => { expired = true; controller.abort(); });
      } catch {
        return started.value ? { status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' }
          : { status: 'failed', error: 'SIDE_EFFECT_DENIED' };
      }
    });
    this.#addLedger.set(command.requestId, { targetMid: command.targetMid,
      ...(command.sourceChatMid === undefined ? {} : { sourceChatMid: command.sourceChatMid }), result });
    const outcome = await result;
    await this.#emit({ type: 'addFriendResult', ...identity, requestId: command.requestId,
      targetMid: command.targetMid, ...outcome });
  }
}
