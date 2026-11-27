// The complete linejs wrapper of the LINE engine.
// It holds the linejs `Client` and its `BaseClient`. It gives, in the style of the linejs `Client` methods, each LINE operation
// that `Client` does not wrap. Each method calls linejs only, with the arguments that the named linejs source file and line use.
// It sets no argument, header, timer, retry or request that linejs does not set in the same flow.
// The engine files call only `Client` (through `client`) and this class. No other file reads the linejs `BaseClient`.
import { BaseClient } from '@evex/linejs/base';
import { Chat, Client, TalkMessage } from '@evex/linejs';
import { trafficLabel } from './traffic-log.js';

export type LinejsFetchOption = ConstructorParameters<typeof BaseClient>[0]['fetch'];
export type LinejsStorageOption = NonNullable<ConstructorParameters<typeof BaseClient>[0]['storage']>;
export type LinejsDeviceOption = ConstructorParameters<typeof BaseClient>[0]['device'];

type Talk = BaseClient['talk'];
type SendArgs = Parameters<Talk['sendMessage']>[0];
type UploadArgs = Parameters<BaseClient['obs']['uploadMediaByE2EE']>[0];
type PreviousRequest = NonNullable<NonNullable<Parameters<Talk['getPreviousMessagesV2WithRequest']>[0]>['request']>;
type AddFriendArgs = Parameters<BaseClient['relation']['addFriendByMid']>[0];

export type LinejsTalkCursor = Readonly<{ revision: bigint; globalRev: bigint; individualRev: bigint }>;

export type LinejsFullClientOptions = Readonly<{
  device: LinejsDeviceOption;
  storage: LinejsStorageOption;
  /** A custom linejs fetch. Absent means that linejs uses its own default fetch. */
  fetch?: LinejsFetchOption;
  /** True turns on LEGY encryption ('auto'). Absent or false means off. */
  legyEncrypted?: boolean;
}>;

export class LinejsFullClient {
  readonly #base: BaseClient;
  readonly #client: Client;

  constructor(options: LinejsFullClientOptions) {
    // linejs default options, except the LEGY encryption setting (the linejs init option `legy.encrypted`):
    // 'auto' when the account setting is on, off otherwise.
    // The device, the storage and (tests) a custom fetch are given.
    this.#base = new BaseClient({ device: options.device, storage: options.storage,
      legy: { encrypted: options.legyEncrypted === true ? 'auto' : false },
      ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.#client = new Client(this.#base);
    // The traffic log reads the label of the running call when undici creates the request. The wrapper only sets that label.
    // It passes the same arguments to linejs `base.request.request` (base/request/mod.ts) and changes no request, header or fetch.
    const request = this.#base.request;
    const original = request.request.bind(request);
    request.request = ((...args: Parameters<typeof original>) =>
      trafficLabel.run(String(args[1]), () => original(...args))) as typeof original;
  }

  /** The linejs `Client`. */
  get client(): Client { return this.#client; }

  // ---- events and state of the linejs BaseClient ----

  /** linejs `base.on('qrcall')` (base/core/utils/events.ts:16). */
  onQrCall(listener: (loginUrl: string) => void): void { this.#base.on('qrcall', listener); }
  /** linejs `base.on('pincall')` (base/core/utils/events.ts:15), as client/login.ts:86 in loginWithPassword. */
  onPinCall(listener: (pincode: string) => void): void { this.#base.on('pincall', listener); }
  /** linejs `base.on('update:authtoken')` (base/core/utils/events.ts:20). */
  onAuthToken(listener: (authToken: string) => void): void { this.#base.on('update:authtoken', listener); }
  /** linejs `base.on('update:qrcert')` (base/core/utils/events.ts:23). */
  onQrCert(listener: (qrCert: string) => void): void { this.#base.on('update:qrcert', listener); }
  /** linejs `base.on('log')` (base/core/utils/events.ts:25). */
  onLog(listener: (entry: { type: string; data: any }) => void): void { this.#base.on('log', listener); }

  /** linejs `base.authToken` (client/login.ts:101 sets it, base/core/mod.ts). */
  get authToken(): string | undefined { return this.#base.authToken; }
  /** linejs `base.authToken = token` (client/login.ts:101). */
  setAuthToken(token: string): void { this.#base.authToken = token; }
  /** linejs `delete base.authToken` (base/core/mod.ts, the same property as client/login.ts:101). */
  clearAuthToken(): void { delete this.#base.authToken; }
  /** linejs `base.profile` (base/core/mod.ts). */
  get profile(): BaseClient['profile'] { return this.#base.profile; }
  /** linejs `base.poll.islisten` (base/polling/mod.ts:22). */
  get isListening(): boolean { return this.#base.poll.islisten; }
  /** linejs `base.push._pingInterval`, in milliseconds (base/push/mod.ts, as used by base/polling/mod.ts). */
  get pushPingIntervalMs(): number { return this.#base.push._pingInterval * 1000; }

  // ---- login and logout ----

  /** linejs `base.loginProcess.login({ qr: true })` (base/login/mod.ts:170), the flow of loginWithQR (client/login.ts:65-71). */
  async loginWithQr(): Promise<void> { await this.#base.loginProcess.login({ qr: true }); }
  /** linejs `base.loginProcess.login({ authToken })` (base/login/mod.ts:170), the steps of loginWithAuthToken (client/login.ts:97-111). */
  async loginWithToken(token: string): Promise<void> { await this.#base.loginProcess.login({ authToken: token }); }
  /**
   * linejs `base.auth.tryRefreshToken()` (base/service/auth/mod.ts:21-41). It sends the refresh request with the stored `refreshToken`,
   * sets `authToken`, emits `update:authtoken` and stores the new `refreshToken` and `expire`. linejs itself calls it only
   * after a `MUST_REFRESH_V3_TOKEN` answer (base/request/mod.ts:219-245).
   */
  tryRefreshToken(): Promise<void> { return this.#base.auth.tryRefreshToken(); }
  /** linejs `base.auth.logoutZ()` (base/service/auth/mod.ts:247). */
  logout() { return this.#base.auth.logoutZ(); }

  // ---- sync cursors ----

  /** linejs `base.poll.sync.talk` (base/polling/mod.ts, SyncData). */
  getTalkCursor(): { revision?: number | bigint; globalRev?: number | bigint; individualRev?: number | bigint } {
    return this.#base.poll.sync.talk;
  }
  /** linejs `base.poll.sync.talk = ...` (base/polling/mod.ts, SyncData). */
  setTalkCursor(cursor: LinejsTalkCursor): void {
    this.#base.poll.sync.talk = { revision: cursor.revision, globalRev: cursor.globalRev, individualRev: cursor.individualRev };
  }
  /** linejs `base.poll.sync.square` (base/polling/mod.ts, SyncData). */
  getSquareToken(): string | undefined { return this.#base.poll.sync.square; }
  /** linejs `base.poll.sync.square = ...` (base/polling/mod.ts, SyncData). */
  setSquareToken(token: string): void { this.#base.poll.sync.square = token; }

  // ---- history ----

  /** linejs `base.talk.getMessageBoxes({ messageBoxListRequest: {} })` (cli/src/commands/shared.ts:82). */
  getMessageBoxes() { return this.#base.talk.getMessageBoxes({ messageBoxListRequest: {} }); }
  /** linejs `base.talk.getPreviousMessagesV2WithRequest({ request })` (cli/src/commands/shared.ts:94), then `TalkMessage.fromRawTalk` (client/features/message/talk.ts:438). */
  async fetchPreviousMessages(request: PreviousRequest): Promise<TalkMessage[]> {
    const raws = await this.#base.talk.getPreviousMessagesV2WithRequest({ request });
    return await Promise.all(raws.map((raw) => TalkMessage.fromRawTalk(raw, this.#client)));
  }
  /** linejs `Chat.fetchMessages(limit)` (client/features/chat/mod.ts:158), as cli/src/commands/chats.ts:105-107. */
  fetchChatMessages(chatMid: string, limit: number): Promise<TalkMessage[]> {
    return new Chat({ client: this.#client, raw: { chatMid } as never }).fetchMessages(limit);
  }

  // ---- send ----

  /** linejs `base.talk.sendMessage({ to, text, e2ee: true, ... })` (cli/src/commands/chats.ts:189). */
  sendToUser(args: Pick<SendArgs, 'to' | 'text' | 'contentMetadata' | 'relatedMessageId'>) {
    return this.#base.talk.sendMessage({ ...args, e2ee: true });
  }
  /**
   * linejs `base.talk.sendMessage({ to: chat mid, text, e2ee: true, contentMetadata, relatedMessageId })`: the call of `Chat.sendMessage`
   * (client/features/chat/mod.ts:57-66). It stops there. `Chat.sendMessage` then runs `TalkMessage.fromRawTalk(sent)` (mod.ts:67-73),
   * which decrypts our own sent message (client/features/message/talk.ts:440) and can fail after LINE took the message.
   */
  sendToChat(args: Pick<SendArgs, 'to' | 'text' | 'contentMetadata' | 'relatedMessageId'>) {
    return this.#base.talk.sendMessage({ ...args, e2ee: true });
  }
  /** linejs `base.obs.uploadMediaByE2EE({ data, oType, to, filename })` (cli/src/commands/chats.ts:258). */
  sendMedia(args: Pick<UploadArgs, 'data' | 'oType' | 'to' | 'filename'>) {
    return this.#base.obs.uploadMediaByE2EE(args);
  }
  /** linejs `base.talk.react({ id, reaction })` (cli/src/commands/messages.ts:58). */
  react(args: Parameters<Talk['react']>[0]) { return this.#base.talk.react({ id: args.id, reaction: args.reaction }); }
  /** linejs `base.talk.cancelReaction({ cancelReactionRequest: { reqSeq, messageId } })` (cli/src/commands/messages.ts:78-83). */
  async cancelReaction(messageId: bigint) {
    return await this.#base.talk.cancelReaction({ cancelReactionRequest: { reqSeq: await this.#base.getReqseq(), messageId } });
  }
  /** linejs `base.talk.unsendMessage({ messageId })` (cli/src/commands/messages.ts:103). */
  unsend(messageId: string) { return this.#base.talk.unsendMessage({ messageId }); }

  // ---- relation ----

  /** linejs `base.relation.addFriendByMid(args)` (cli/src/commands/contacts.ts:147; the group member form: base/service/relation/mod.test.ts:47-52). */
  addFriendByMid(args: AddFriendArgs) { return this.#base.relation.addFriendByMid(args); }

  /** linejs `base.talk.getContactsV2({ mids })` (client/client.js:242, the V2 step of `fetchUsers`). */
  getContactsV2(mids: string[]) { return this.#base.talk.getContactsV2({ mids }); }

  // ---- notes ----

  /** linejs `base.timeline.listPost({ homeId, postId? })` (cli/src/commands/timeline.ts:165). */
  listNotes(args: Parameters<BaseClient['timeline']['listPost']>[0]): ReturnType<BaseClient['timeline']['listPost']> { return this.#base.timeline.listPost(args); }
  /** linejs `base.timeline.getPost({ homeId, postId })` (cli/src/commands/timeline.ts:191). */
  getNote(args: Parameters<BaseClient['timeline']['getPost']>[0]): ReturnType<BaseClient['timeline']['getPost']> { return this.#base.timeline.getPost(args); }

  // ---- albums ----

  /** linejs `base.moa.getAlbums({ cursor? })` (cli/src/commands/moa.ts:29). */
  listAlbums(args: Parameters<BaseClient['moa']['getAlbums']>[0]): ReturnType<BaseClient['moa']['getAlbums']> { return this.#base.moa.getAlbums(args); }
  /** linejs `base.moa.getPhotos({ chatId, albumId, cursor?, pageSize })` (cli/src/commands/moa.ts:98). */
  listAlbumPhotos(args: Parameters<BaseClient['moa']['getPhotos']>[0]): ReturnType<BaseClient['moa']['getPhotos']> { return this.#base.moa.getPhotos(args); }
  /** linejs `base.moa.downloadPhoto({ chatId, albumId, oid, prefix })` (cli/src/commands/moa.ts:158). */
  downloadAlbumPhoto(args: Parameters<BaseClient['moa']['downloadPhoto']>[0]) { return this.#base.moa.downloadPhoto(args); }

  // ---- message data ----

  /** linejs `TalkMessage.fromRawTalk(raw, client)` (client/features/message/talk.ts:438), then `getData()` (talk.ts:352), as cli/src/commands/messages.ts:273. */
  async downloadMessageData(raw: Parameters<typeof TalkMessage.fromRawTalk>[0],
    guard: (data: Promise<Blob>) => Promise<Blob> = (data) => data): Promise<Blob> {
    const message = await TalkMessage.fromRawTalk(raw, this.#client);
    // `guard` only waits for the linejs promise (the engine races it with an abort signal). It starts no request.
    return await guard(message.getData());
  }
  /**
   * linejs `TalkMessage.fromRawTalk(raw, client)` (client/features/message/talk.ts:438), then
   * `base.obs.downloadMediaByE2EE(message)` (base/obs/mod.ts:430-475), the same call as `TalkMessage.getData()` (talk.ts:360).
   * The result is a `File` whose name is the `fileName` that `e2ee.decryptE2EEDataMessage` reads from the encrypted chunks.
   */
  async downloadE2eeMessageFile(raw: Parameters<typeof TalkMessage.fromRawTalk>[0],
    guard: (data: Promise<File | null>) => Promise<File | null> = (data) => data): Promise<File | null> {
    const message = await TalkMessage.fromRawTalk(raw, this.#client);
    // `guard` only waits for the linejs promise. It starts no request.
    return await guard(this.#base.obs.downloadMediaByE2EE(message.raw));
  }
}
