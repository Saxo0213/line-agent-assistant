import type { ChatResourceReadCommand, ConversationCatalogItem } from '@line-agent/contracts';
import type { HistoryCursorV1 } from './cursor.js';
import type { FriendAddResult, FriendRelation, LineTransport, SyncResult, TransportIdentity } from './worker-loop.js';

export class FakeLineTransport implements LineTransport {
  readonly loginCalls: ('qr' | 'token')[] = [];
  readonly syncCalls: unknown[] = [];
  readonly sendCalls: unknown[] = [];
  readonly reactCalls: unknown[] = [];
  readonly unsendCalls: unknown[] = [];
  readonly historyCalls: unknown[] = [];
  readonly downloadCalls: unknown[] = [];
  readonly friendCheckCalls: unknown[] = [];
  readonly friendAddCalls: unknown[] = [];
  readonly chatResourceCalls: unknown[] = [];
  readonly #chatResourceQueue: Array<Readonly<{ nextCursor?: string | null; notes?: readonly unknown[]; note?: unknown; albums?: readonly unknown[]; photos?: readonly unknown[]; bytes?: Uint8Array }>> = [];
  catalogCalls = 0;
  catalogError?: Error;
  readonly #historyQueue: (readonly unknown[])[] = [];
  readonly #downloadQueue: Array<{ bytes: Uint8Array; name: string | null }> = [];
  sendError?: Error;
  unsendError?: Error;
  friendCheckResult: FriendRelation = 'not_friend';
  friendAddResult: FriendAddResult = { status: 'added', error: null };
  friendAddError?: Error;
  syncError?: Error;
  sendStarted: Promise<void> = Promise.resolve();
  #signalSendStarted?: () => void;
  #sendWait?: Promise<void>;
  readonly #identity: TransportIdentity;
  readonly #syncQueue: SyncResult[] = [];
  readonly #catalogQueue: (readonly ConversationCatalogItem[])[] = [];
  #listeners: Partial<Record<'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated', (value?: any) => void>> = {};
  constructor(identity: TransportIdentity) { this.#identity = identity; }
  on(event: 'qr' | 'pin' | 'token' | 'qrCert' | 'storage' | 'credentials' | 'authInvalidated', listener: (value?: any) => void): void { this.#listeners[event] = listener; }
  rotateCredentials(credentials: { token: string; e2eeStorage: import('@line-agent/contracts').JsonValue }): void {
    this.#listeners.credentials?.(credentials);
  }
  async installSecrets(_secrets: unknown): Promise<void> {}
  async loginQr(): Promise<TransportIdentity> {
    this.loginCalls.push('qr');
    this.#listeners.qr?.('qr-url');
    this.#listeners.pin?.('1234');
    return this.#identity;
  }
  async loginToken(_token: string): Promise<TransportIdentity> {
    this.loginCalls.push('token');
    return this.#identity;
  }
  enqueueConversationCatalog(conversations: readonly ConversationCatalogItem[]): void {
    this.#catalogQueue.push(conversations);
  }
  async listConversations(): Promise<readonly ConversationCatalogItem[]> {
    this.catalogCalls += 1;
    if (this.catalogError) throw this.catalogError;
    return this.#catalogQueue.shift() ?? [];
  }
  enqueueSync(result: SyncResult): void { this.#syncQueue.push(result); }
  async sync(cursor: unknown): Promise<SyncResult> {
    this.syncCalls.push(cursor);
    if (this.syncError) throw this.syncError;
    return this.#syncQueue.shift() ?? { cursorAfter: cursor as SyncResult['cursorAfter'], operations: [] };
  }
  enqueueHistory(messages: readonly unknown[]): void { this.#historyQueue.push(messages); }
  async history(conversation: { chatType: 'direct' | 'group' | 'room'; chatId: string }, cursor: HistoryCursorV1 | null,
    limit: number): Promise<readonly unknown[]> {
    this.historyCalls.push({ conversation, cursor, limit });
    return this.#historyQueue.shift() ?? [];
  }
  enqueueChatResource(result: Readonly<{ nextCursor?: string | null; notes?: readonly unknown[]; note?: unknown; albums?: readonly unknown[]; photos?: readonly unknown[]; bytes?: Uint8Array }>): void {
    this.#chatResourceQueue.push(result);
  }
  async readChatResource(command: ChatResourceReadCommand, options: Readonly<{ signal: AbortSignal }>) {
    this.chatResourceCalls.push(command);
    if (options.signal.aborted) throw options.signal.reason;
    const result = this.#chatResourceQueue.shift();
    if (!result) throw new Error('fake chat resource unavailable');
    return result;
  }
  enqueueDownload(bytes: Uint8Array, name: string | null = null): void { this.#downloadQueue.push({ bytes, name }); }
  async download(kind: 'image' | 'video' | 'audio' | 'file', messageId: string,
    externalAttachmentId: string, lineMessage: import('@line-agent/contracts').JsonValue,
    options: Readonly<{ signal: AbortSignal; maxBytes: number }>): Promise<{
      name: string | null; source: AsyncIterable<Uint8Array>;
    }> {
    this.downloadCalls.push({ kind, messageId, externalAttachmentId, lineMessage });
    if (options.signal.aborted) throw options.signal.reason;
    const result = this.#downloadQueue.shift();
    if (!result) throw new Error('fake download source unavailable');
    return { name: result.name, source: (async function* () { yield result.bytes; })() };
  }
  async send(conversation: { chatType: string; chatId: string }, text: string, replyToMessageId: string | null, lease: unknown,
    manual = false): Promise<{ messageId: string }> {
    this.sendCalls.push({ ...conversation, text, replyToMessageId, lease, manual });
    this.#signalSendStarted?.();
    if (this.#sendWait) await this.#sendWait;
    if (this.sendError) throw this.sendError;
    return { messageId: 'sent-1' };
  }
  readonly sendMediaCalls: unknown[] = [];
  sendMediaError?: Error;
  sendMediaHold?: Promise<void>;
  async sendMedia(conversation: { chatType: string; chatId: string }, media: { kind: string; bytes: Buffer; fileName: string },
    lease: unknown): Promise<{ messageId: string }> {
    this.sendMediaCalls.push({ ...conversation, kind: media.kind, bytes: Buffer.from(media.bytes), fileName: media.fileName, lease });
    if (this.sendMediaHold) await this.sendMediaHold;
    if (this.sendMediaError) throw this.sendMediaError;
    return { messageId: 'media-1' };
  }
  async react(conversation: { chatType: string; chatId: string }, messageId: string, reaction: string, _lease: unknown): Promise<void> {
    this.reactCalls.push({ ...conversation, messageId, reaction });
  }
  async unsend(conversation: { chatType: string; chatId: string }, messageId: string, lease: unknown): Promise<void> {
    this.unsendCalls.push({ ...conversation, messageId, lease });
    if (this.unsendError) throw this.unsendError;
  }
  async checkFriendRelation(targetMid: string, lease: unknown): Promise<FriendRelation> {
    this.friendCheckCalls.push({ targetMid, lease });
    return this.friendCheckResult;
  }
  async addFriendByMid(targetMid: string, lease: unknown, onPhysicalStart: () => void): Promise<FriendAddResult> {
    this.friendAddCalls.push({ targetMid, lease });
    onPhysicalStart();
    if (this.friendAddError) throw this.friendAddError;
    return this.friendAddResult;
  }
  pauseSend(): () => void {
    this.sendStarted = new Promise<void>((resolve) => { this.#signalSendStarted = resolve; });
    this.#sendWait = new Promise<void>((resolve) => { this.#releaseSend = resolve; });
    return () => this.#releaseSend?.();
  }
  #releaseSend?: () => void;
  rotateToken(token: string): void { this.#listeners.token?.(token); }
}
