import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseClient } from '@evex/linejs/base';
import { Protocols } from '@evex/linejs/thrift';
import { createLinejsClientEngine, type LinejsClientEngineOptions } from './linejs-client-engine.js';
import { EffectDeniedError } from './mutation-gate.js';

const lease = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const OWN = `u${'a'.repeat(32)}`;
const PEER = `u${'b'.repeat(32)}`;
const GROUP = `c${'c'.repeat(32)}`;
const TOKEN = 'opaque-test-token';
const cursor = { version: 1 as const, revision: '10', globalRev: '20', individualRev: '30' };

type Called = { method: string; data: Record<string, any>; path: string; token: string | null };
const thrift = new BaseClient({ device: 'DESKTOPWIN' }).thrift;

/** A linejs-shaped REPLY for `method`. `fields` is the linejs writeThrift field list of the result struct. */
function reply(method: string, fields: unknown[]): Response {
  const body = Buffer.from(thrift.writeThrift(fields as never, method, Protocols[4]!));
  body[1] = 0x41; // Compact protocol version 1 with a REPLY message type.
  return new Response(body);
}
const success = (method: string, struct: unknown[] = []) => reply(method, [[12, 0, struct]]);
const exception = (method: string, code: number) => reply(method, [[12, 1, [[8, 1, code], [11, 2, 'private text']]]]);

function engine(handler: (call: Called) => Response | Promise<Response>, extra: Partial<LinejsClientEngineOptions> = {}) {
  const calls: Called[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const parsed = thrift.readThrift(new Uint8Array(await request.arrayBuffer()), Protocols[4]!);
    const call = { method: parsed._info.fname, data: parsed.data as Record<string, any>,
      path: new URL(request.url).pathname, token: request.headers.get('x-line-access') };
    calls.push(call);
    return await handler(call);
  };
  const instance = createLinejsClientEngine({ ...lease, mode: 'ACTIVE_CONTROL', fetch, syncWaitMs: 2_000, ...extra });
  return { instance, calls };
}
const profileReply = () => success('getProfile', [[11, 1, OWN], [11, 20, 'Agent']]);

afterEach(() => { vi.restoreAllMocks(); });

describe('linejs client engine', () => {
  it('emits the QR and PIN events of linejs and returns the profile that linejs loaded', async () => {
    const { Login } = await import(new URL('../../../node_modules/@evex/linejs/base/login/mod.js', import.meta.url).href) as {
      Login: { prototype: { withQrCode: (...args: any[]) => Promise<void> } };
    };
    vi.spyOn(Login.prototype, 'withQrCode').mockImplementation(async function (this: { client: BaseClient }) {
      this.client.emit('qrcall', 'https://line.me/R/au/q/test');
      this.client.emit('pincall', '123456');
      this.client.emit('update:qrcert', 'cert-1');
      this.client.emit('update:authtoken', TOKEN);
      this.client.authToken = TOKEN;
    });
    const { instance, calls } = engine(() => profileReply());
    const events: [string, unknown][] = [];
    for (const name of ['qr', 'pin', 'token', 'qrCert'] as const) instance.on(name, (value) => events.push([name, value]));
    const identity = await instance.loginQr();
    expect(events).toEqual([['qr', 'https://line.me/R/au/q/test'], ['pin', '123456'], ['qrCert', 'cert-1'], ['token', TOKEN]]);
    expect(identity).toMatchObject({ ownMid: OWN, displayName: 'Agent' });
    expect(calls.map((call) => call.method)).toEqual(['getProfile']);
    instance.revoke();
  });

  it('logs in with a saved token through the linejs auth token flow', async () => {
    const { instance, calls } = engine(() => profileReply());
    const storage = vi.fn();
    instance.on('storage', storage);
    await instance.installSecrets({ token: TOKEN, qrCert: 'cert', e2eeStorage: { keep: 'me' } });
    expect(storage).not.toHaveBeenCalled();
    const identity = await instance.loginToken(TOKEN);
    expect(identity).toMatchObject({ ownMid: OWN, displayName: 'Agent' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'getProfile', path: '/S4', token: TOKEN });
    instance.revoke();
  });

  describe('token refresh', () => {
    async function authSpy() {
      const { AuthService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/auth/mod.js', import.meta.url).href) as {
        AuthService: { prototype: Record<string, (...args: any[]) => Promise<unknown>> };
      };
      return vi.spyOn(AuthService.prototype, 'refresh');
    }
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const refreshed = () => ({ accessToken: 'new-token', refreshToken: 'r2', tokenIssueTimeEpochSec: nowSeconds(), durationUntilRefreshInSec: 3600 });

    it('refreshes an expired token before the login and logs in with the new token', async () => {
      const refresh = (await authSpy()).mockResolvedValue(refreshed());
      const { instance, calls } = engine(() => profileReply());
      const credentials = vi.fn();
      instance.on('credentials', credentials);
      await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: { refreshToken: 'r1', expire: nowSeconds() - 10 } });
      await instance.loginToken(TOKEN);
      expect(refresh).toHaveBeenCalledOnce();
      expect(calls[0]).toMatchObject({ method: 'getProfile', token: 'new-token' });
      expect(credentials).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-token' }));
      instance.revoke();
    });

    it('does not refresh a token that has not expired', async () => {
      const refresh = (await authSpy()).mockResolvedValue(refreshed());
      const { instance, calls } = engine(() => profileReply());
      await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: { refreshToken: 'r1', expire: nowSeconds() + 3600 } });
      await instance.loginToken(TOKEN);
      expect(refresh).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ token: TOKEN });
      instance.revoke();
    });

    it('refreshes at the stored expiry time and persists the new credentials', async () => {
      const refresh = (await authSpy()).mockResolvedValue(refreshed());
      const { instance } = engine(() => profileReply());
      const credentials = vi.fn();
      instance.on('credentials', credentials);
      await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: { refreshToken: 'r1', expire: nowSeconds() + 1 } });
      await vi.waitFor(() => expect(credentials).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-token' })), { timeout: 3_000 });
      expect(refresh).toHaveBeenCalledOnce();
      instance.revoke();
    });

    it('emits refreshFailure when the scheduled refresh fails', async () => {
      (await authSpy()).mockRejectedValue(new Error('network down'));
      const { instance } = engine(() => profileReply());
      const failure = vi.fn();
      instance.on('refreshFailure', failure);
      await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: { refreshToken: 'r1', expire: nowSeconds() + 1 } });
      await vi.waitFor(() => expect(failure).toHaveBeenCalledWith({ code: 'LINE_TOKEN_REFRESH_FAILED' }), { timeout: 3_000 });
      instance.revoke();
    });
  });

  it('labels each linejs request for the traffic log with its method name', async () => {
    const { trafficLabel } = await import('./traffic-log.js');
    const labels: (string | undefined)[] = [];
    const { instance } = engine(() => { labels.push(trafficLabel.getStore()); return profileReply(); });
    await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: null });
    await instance.refreshOwnProfile();
    expect(labels).toEqual(['getProfile']);
    instance.revoke();
  });

  describe('receive', () => {
    async function listening() {
      const { Polling } = await import(new URL('../../../node_modules/@evex/linejs/base/polling/mod.js', import.meta.url).href) as {
        Polling: { prototype: { initLegyPusher: (...args: any[]) => Promise<void> } };
      };
      const state: { base?: BaseClient; startCursor?: unknown; starts: number } = { starts: 0 };
      vi.spyOn(Polling.prototype, 'initLegyPusher').mockImplementation(async function (this: { client: BaseClient }) {
        state.base = this.client;
        state.starts += 1;
        state.startCursor = { ...this.client.poll.sync.talk };
      });
      return state;
    }

    it('starts listening from the given cursor and returns the queued operations with cursorAfter', async () => {
      const state = await listening();
      const { instance, calls } = engine(() => profileReply());
      const message = { from: PEER, to: OWN, toType: 'USER', id: '501', contentType: 'NONE', contentMetadata: {}, text: 'hello' };
      const pending = instance.sync(cursor);
      await vi.waitFor(() => expect(state.base).toBeDefined());
      expect(state.startCursor).toEqual({ revision: 10n, globalRev: 20n, individualRev: 30n });
      const base = state.base!;
      base.poll.sync.talk = { revision: 41n, globalRev: 22n, individualRev: 33n };
      base.push.opStream.enqueue({ revision: 40, type: 'NOTIFIED_DESTROY_MESSAGE', param1: GROUP, param2: '777', createdTime: 1_700_000_000_000 } as never);
      base.push.opStream.enqueue({ revision: 41, type: 'RECEIVE_MESSAGE', message } as never);
      const result = await pending;
      expect(result.operations).toEqual([{ revision: 41, type: 'RECEIVE_MESSAGE', message }]);
      expect(result.unsends).toEqual([{ chatId: GROUP, messageId: '777', kind: 'notified', observedAt: '2023-11-14T22:13:20.000Z' }]);
      expect(result.cursorAfter).toEqual({ version: 1, revision: '41', globalRev: '22', individualRev: '33' });
      expect(result.rawOperationCount).toBe(2);
      // A second call does not start a second listener and does not reset the cursor.
      base.poll.sync.talk = { revision: 50n, globalRev: 22n, individualRev: 33n };
      base.push.opStream.enqueue({ revision: 50, type: 'NOTIFIED_READ_MESSAGE', param1: GROUP, param2: PEER, param3: '501', createdTime: 1_700_000_001_000 } as never);
      const second = await instance.sync(cursor);
      expect(state.starts).toBe(1);
      expect(second.operations).toEqual([]);
      expect(second.readReceipts).toEqual([{ chatId: GROUP, readerMid: PEER, messageId: '501', readAt: '2023-11-14T22:13:21.000Z' }]);
      expect(second.cursorAfter.revision).toBe('50');
      expect(calls).toHaveLength(0);
      instance.revoke();
    });

    it('returns at most 100 operations per call after an offline backlog and keeps the event revisions behind until the queue is empty', async () => {
      const state = await listening();
      const { instance } = engine(() => profileReply());
      const first = instance.sync(cursor);
      await vi.waitFor(() => expect(state.base).toBeDefined());
      const base = state.base!;
      const read = (revision: number) => ({ revision, type: 'NOTIFIED_READ_MESSAGE', param1: GROUP, param2: PEER, param3: '501', createdTime: 1_700_000_000_000 });
      base.poll.sync.talk = { revision: 5n, globalRev: 21n, individualRev: 31n };
      base.push.opStream.enqueue(read(5) as never);
      await first;
      base.poll.sync.talk = { revision: 160n, globalRev: 22n, individualRev: 33n };
      for (let revision = 10; revision < 160; revision += 1) base.push.opStream.enqueue(read(revision) as never);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const batch1 = await instance.sync(cursor);
      expect(batch1.rawOperationCount).toBe(100);
      expect(batch1.cursorAfter).toEqual({ version: 1, revision: '109', globalRev: '21', individualRev: '31' });
      const batch2 = await instance.sync(cursor);
      expect(batch2.rawOperationCount).toBe(50);
      expect(batch2.cursorAfter).toEqual({ version: 1, revision: '160', globalRev: '22', individualRev: '33' });
      instance.revoke();
    });
  });

  describe('writes', () => {
    async function talkSpies() {
      const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
        TalkService: { prototype: Record<string, (...args: any[]) => Promise<unknown>> };
      };
      const sendMessage = vi.spyOn(TalkService.prototype, 'sendMessage').mockResolvedValue({ id: '9001', to: GROUP, contentMetadata: {} });
      const getChats = vi.spyOn(TalkService.prototype, 'getChats').mockResolvedValue({ chats: [{ chatMid: GROUP, chatName: 'Group' }] });
      return { sendMessage, getChats };
    }

    it('sends to a group with the base sendMessage call of Chat.sendMessage, returns its id and decrypts nothing', async () => {
      const { sendMessage, getChats } = await talkSpies();
      const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
        E2EE: { prototype: Record<string, (...args: any[]) => unknown> };
      };
      const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEMessage').mockRejectedValue(new Error('decrypt must not run'));
      const { instance, calls } = engine(() => profileReply());
      const result = await instance.send({ chatType: 'group', chatId: GROUP }, 'hi @x', '444', lease, false,
        [{ start: 3, end: 5, userId: PEER }]);
      expect(result).toEqual({ messageId: '9001' });
      expect(getChats).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0]![0]).toEqual({ to: GROUP, text: 'hi @x', e2ee: true, relatedMessageId: '444',
        contentMetadata: { MENTION: JSON.stringify({ MENTIONEES: [{ S: '3', E: '5', M: PEER }] }) } });
      expect(calls).toHaveLength(0);
    });

    it('sends to a direct chat by any user MID with the linejs CLI chats send call', async () => {
      const { sendMessage, getChats } = await talkSpies();
      const { instance } = engine(() => profileReply());
      const result = await instance.send({ chatType: 'direct', chatId: PEER }, 'hello', null, lease);
      expect(result).toEqual({ messageId: '9001' });
      expect(getChats).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0]![0]).toEqual({ to: PEER, text: 'hello', e2ee: true });
    });

    it('denies a write without a valid lease or in a read-only mode before any linejs call', async () => {
      const { sendMessage, getChats } = await talkSpies();
      const { instance, calls } = engine(() => profileReply());
      const wrong = { ...lease, controlEpoch: 8 };
      await expect(instance.send({ chatType: 'group', chatId: GROUP }, 'x', null, wrong)).rejects.toBeInstanceOf(EffectDeniedError);
      await expect(instance.react({ chatType: 'group', chatId: GROUP }, '1', 'NICE', wrong)).rejects.toBeInstanceOf(EffectDeniedError);
      await expect(instance.unsend?.({ chatType: 'group', chatId: GROUP }, '1', wrong)).rejects.toBeInstanceOf(EffectDeniedError);
      const monitor = engine(() => profileReply(), { mode: 'MONITOR_ONLY' });
      await expect(monitor.instance.send({ chatType: 'direct', chatId: PEER }, 'x', null, lease)).rejects.toBeInstanceOf(EffectDeniedError);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getChats).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(monitor.calls).toHaveLength(0);
    });

    it('follows the original MONITOR_ONLY rule: manual send, manual media and unsend pass; other writes and PAUSED do not', async () => {
      const { sendMessage } = await talkSpies();
      const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
        TalkService: { prototype: Record<string, (...args: any[]) => Promise<unknown>> };
      };
      const unsendMessage = vi.spyOn(TalkService.prototype, 'unsendMessage').mockResolvedValue(undefined);
      const react = vi.spyOn(TalkService.prototype, 'react').mockResolvedValue(undefined);
      const monitor = engine(() => profileReply(), { mode: 'MONITOR_ONLY' }).instance;
      const group = { chatType: 'group' as const, chatId: GROUP };
      expect(await monitor.send(group, 'x', null, lease, true)).toEqual({ messageId: '9001' });
      await expect(monitor.send(group, 'x', null, lease, false)).rejects.toBeInstanceOf(EffectDeniedError);
      await expect(monitor.sendMedia(group, { kind: 'file', bytes: Buffer.from('a'), fileName: 'a.txt' }, lease, false))
        .rejects.toBeInstanceOf(EffectDeniedError);
      await monitor.unsend(group, '1', lease);
      expect(unsendMessage).toHaveBeenCalledOnce();
      await expect(monitor.react(group, '1', 'NICE', lease)).rejects.toBeInstanceOf(EffectDeniedError);
      await expect(monitor.send(group, 'x', null, { ...lease, controlEpoch: 8 }, true)).rejects.toBeInstanceOf(EffectDeniedError);
      const paused = engine(() => profileReply(), { mode: 'PAUSED' }).instance;
      await expect(paused.send(group, 'x', null, lease, true)).rejects.toBeInstanceOf(EffectDeniedError);
      await expect(paused.unsend(group, '1', lease)).rejects.toBeInstanceOf(EffectDeniedError);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(react).not.toHaveBeenCalled();
    });

    it('denies friend add with SIDE_EFFECT_DENIED and makes no request', async () => {
      const { instance, calls } = engine(() => success('addFriendByMid'));
      await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: null });
      const started = vi.fn();
      expect(await instance.addFriendByMid(PEER, lease, started, undefined, GROUP))
        .toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
      expect(await instance.addFriendByMid(PEER, lease, started))
        .toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
      expect(started).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });
  });

  it('emits authInvalidated and keeps the real LINE error code when linejs reports NOT_AUTHORIZED_DEVICE', async () => {
    const { instance } = engine(() => exception('getProfile', 8));
    await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: null });
    const invalidated = vi.fn();
    instance.on('authInvalidated', invalidated);
    await expect(instance.refreshOwnProfile()).rejects.toBeDefined();
    await expect(instance.refreshOwnProfile()).rejects.toBeDefined();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(invalidated.mock.calls[0]![0]).toMatchObject({ upstreamCode: 8 });
    instance.revoke();
  });

  it('marks a friend member true and a blocked friend member false in the catalog', async () => {
    const { Client } = await import('@evex/linejs');
    vi.spyOn(Client.prototype, 'fetchJoinedChats').mockResolvedValue([]);
    const user = (mid: string, extra: Record<string, unknown>) => ({ mid, raw: { targetProfileDetail: { profileName: mid }, ...extra } });
    vi.spyOn(Client.prototype, 'fetchUsers').mockResolvedValue([
      user(PEER, { friendDetail: { user: {} } }), user(`u${'d'.repeat(32)}`, { blockDetail: { user: {} } })] as never);
    const { instance } = engine(() => profileReply());
    const items = await instance.listConversations();
    expect(items.map((item) => [item.chatId, item.members[0]!.friend])).toEqual([[PEER, true], [`u${'d'.repeat(32)}`, false]]);
    instance.revoke();
  });

  it('reads name, nickname, picture and blocked state from the V2 contact shape in the catalog', async () => {
    const { Client } = await import('@evex/linejs');
    vi.spyOn(Client.prototype, 'fetchJoinedChats').mockResolvedValue([]);
    const blocked = `u${'d'.repeat(32)}`;
    vi.spyOn(Client.prototype, 'fetchUsers').mockResolvedValue([
      { mid: PEER, raw: { targetUserMid: PEER, contact: { displayName: 'Ann', displayNameOverridden: 'Annie', picturePath: '/p/abc', status: 1 } } },
      { mid: blocked, raw: { targetUserMid: blocked, contact: { displayName: 'Bob', status: 'FRIEND_BLOCKED' } } }] as never);
    const { instance } = engine(() => profileReply());
    const items = await instance.listConversations();
    expect(items.map((item) => [item.title, item.members[0]!.displayName, item.members[0]!.nickname, item.members[0]!.friend]))
      .toEqual([['Annie', 'Ann', 'Annie', true], ['Bob', 'Bob', undefined, false]]);
    expect(items[0]!.picturePath).toEqual(expect.any(String));
    instance.revoke();
  });

  it('returns the linejs fileName of an E2EE file and keeps no name for a plain download', async () => {
    const { LinejsFullClient } = await import('./linejs-client-full.js');
    const e2ee = vi.spyOn(LinejsFullClient.prototype, 'downloadE2eeMessageFile')
      .mockResolvedValue(new File([new Uint8Array([1, 2, 3])], 'report.pdf'));
    const plain = vi.spyOn(LinejsFullClient.prototype, 'downloadMessageData').mockResolvedValue(new Blob([new Uint8Array([4])]));
    const { instance } = engine(() => profileReply());
    await instance.loginToken(TOKEN);
    const identity = { accountId: 'account-A', chatType: 'direct' as const, chatId: PEER, ownMid: OWN, messageId: '100', kind: 'file' as const,
      externalAttachmentId: 'oid1' };
    const message = { id: '100', from: PEER, to: OWN, toType: 0, contentType: 14, chunks: ['AAAA'], contentMetadata: { OID: 'oid1', SID: 'emf' } };
    const result = await instance.download('file', '100', 'oid1', message as never, { signal: new AbortController().signal, maxBytes: 1024, identity });
    expect(result.name).toBe('report.pdf');
    const received: number[] = [];
    for await (const chunk of result.source) received.push(...chunk);
    expect(received).toEqual([1, 2, 3]);
    expect(e2ee).toHaveBeenCalledOnce();
    expect(plain).not.toHaveBeenCalled();
    instance.revoke();
  });

  it('keeps a decoded Talk rejection as a LINE_TALK error and does not invalidate the session', async () => {
    const { instance } = engine(() => exception('getProfile', 4));
    await instance.installSecrets({ token: TOKEN, qrCert: null, e2eeStorage: null });
    const invalidated = vi.fn();
    instance.on('authInvalidated', invalidated);
    await expect(instance.refreshOwnProfile()).rejects.toMatchObject({ code: 'LINE_TALK_EXCESSIVE_ACCESS', upstreamCode: 4 });
    expect(invalidated).not.toHaveBeenCalled();
  });

  it('lists the albums of a direct chat by the one-to-one chat id (homeChatId), not the peer MID', async () => {
    const { readLinejsChatResource } = await import('./linejs-client-engine-resources.js');
    const home = `o${'c'.repeat(32)}`;
    const listAlbums = vi.fn(async () => ({ result: { albums: [
      { albumId: '1', chatId: home, title: 'mine', photoCount: 2 }, { albumId: '2', chatId: PEER, title: 'other', photoCount: 1 }] } }));
    const full = { authToken: TOKEN, profile: { mid: OWN }, listAlbums } as never;
    const command = { type: 'readChatResource', action: 'listAlbums', chatType: 'direct', chatId: PEER, homeChatId: home } as never;
    const value = await readLinejsChatResource(full, command, new AbortController().signal);
    // The result keeps the requested chat id (the peer MID), so Main matches the album to the conversation.
    expect(value.albums).toEqual([expect.objectContaining({ albumId: '1', chatId: PEER })]);
  });
});
