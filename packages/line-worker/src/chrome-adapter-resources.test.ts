// Step 7 tests: `readChatResource` on the CHROMEOS transport. Albums follow line-cli (channel token + album preview GET);
// notes, the album list, the photo list and video downloads are typed UNSUPPORTED. Fakes only, no network.
import { describe, expect, it } from 'vitest';
import { FakeHmacSigner, CHROME_TRANSPORT_TAG, type ReceiveClock } from '@line-agent/line-chrome';
import { LineWorkerEventSchema, type ChatResourceReadCommand, type LineWorkerEvent } from '@line-agent/contracts';
import { createChromeAdapter, type ChromeAdapter, type ChromeAdapterBridge } from './chrome-adapter.js';
import { ChatResourceFailure, ChatResourceUnsupportedError } from './chat-resource-error.js';
import { EffectDeniedError } from './mutation-gate.js';
import { FakeLineTransport } from './fake-transport.js';
import { LineWorkerLoop } from './worker-loop.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const SELF = `u${'a'.repeat(32)}`;
const GROUP = `c${'c'.repeat(32)}`;
const NOW = 1_700_000_000_000;
const CHANNEL_TOKEN_PATH = '/api/talk/thrift/Talk/ChannelService/issueChannelToken';
const cursor0 = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };

const ok = (data: unknown): Response => new Response(JSON.stringify({ message: 'OK', data }), { status: 200 });
type Reply = Response | Error | (() => Response | Promise<Response>);
type Recorded = { url: string; path: string; method: string; headers: Array<[string, string]>; body: string | undefined };
class FakeServer {
  readonly requests: Recorded[] = [];
  private readonly queues = new Map<string, Reply[]>();
  on(path: string, ...replies: Reply[]): this { this.queues.set(path, [...(this.queues.get(path) ?? []), ...replies]); return this; }
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    this.requests.push({ url, path, method: init.method ?? 'GET',
      headers: (init.headers as Array<[string, string]>).map(([name, value]) => [name, value]), body: init.body as string | undefined });
    const next = this.queues.get(path)?.shift();
    if (next === undefined) throw new Error(`unexpected request to ${path}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  to(path: string): Recorded[] { return this.requests.filter((request) => request.path === path); }
}
const inertClock: ReceiveClock = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => undefined };
const timers = { set: () => 1, clear: () => undefined };
const bridge = { e2eeGetKeyId: async () => 1000, e2eeExportKey: async () => 'blob', e2eeLoadKey: async () => 101 } as unknown as ChromeAdapterBridge;
const snapshot = () => ({ transport: CHROME_TRANSPORT_TAG, refreshToken: 'refresh-0', tokenIssueTimeEpochSec: 1_700_000_000,
  durationUntilRefreshInSec: 3600, mid: SELF });

async function build(options: { mode?: 'MONITOR_ONLY' | 'ACTIVE_CONTROL'; loggedIn?: boolean; timers?: typeof timers; now?: () => number } = {}) {
  const server = new FakeServer();
  const adapter: ChromeAdapter = await createChromeAdapter({
    ...binding, mode: options.mode ?? 'ACTIVE_CONTROL', validateLease: () => true, fetch: server.fetch, signer: new FakeHmacSigner(), bridge,
    receiveClock: inertClock, receiveWaitMs: 0, timers: options.timers ?? timers, now: options.now ?? (() => NOW),
  });
  if (options.loggedIn !== false) await adapter.installSecrets({ token: 'account-token', qrCert: null, e2eeStorage: snapshot() });
  return { server, adapter };
}

type Command = ChatResourceReadCommand;
const download = (over: Partial<Command> = {}): Command => ({ type: 'chatResourceRead', ...binding, chatType: 'group', chatId: GROUP,
  requestId: 'r1', action: 'downloadAlbumPhoto', albumId: 'album-1', photoId: 'photo-1', oid: 'oid-1', prefix: 'album/a',
  maxBytes: 1024, timeoutMs: 10_000, ...over }) as Command;
const signal = () => new AbortController().signal;
const header = (request: Recorded, name: string) => request.headers.find(([n]) => n === name)?.[1];
const tokenReply = (token = 'channel-token', expiration: unknown = NOW + 3_600_000) => ok({ channelAccessToken: token, expiration });

describe('ChromeAdapter.readChatResource: album photo download (line-cli)', () => {
  it('issues the album channel token, then GETs the preview with the line-cli headers', async () => {
    const { adapter, server } = await build();
    server.on(CHANNEL_TOKEN_PATH, tokenReply());
    server.on('/r/album/a/oid-1/f482x482', new Response(new Uint8Array([1, 2, 3])));
    const result = await adapter.readChatResource(download(), { signal: signal() });
    expect(result).toEqual({ bytes: Buffer.from([1, 2, 3]) });

    const [issue] = server.to(CHANNEL_TOKEN_PATH);
    expect(issue!.url).toBe(`https://line-chrome-gw.line-apps.com${CHANNEL_TOKEN_PATH}`);
    expect(issue!.method).toBe('POST');
    expect(issue!.body).toBe('["1341209850"]');
    expect(header(issue!, 'X-Line-Access')).toBe('account-token');
    expect(header(issue!, 'X-Line-ChannelToken')).toBeUndefined();
    expect(header(issue!, 'X-Line-Application')).toBeUndefined();

    const [photo] = server.to('/r/album/a/oid-1/f482x482');
    expect(photo!.url).toBe('https://obs.line-apps.com/r/album/a/oid-1/f482x482');
    expect(photo!.method).toBe('GET');
    expect(header(photo!, 'X-Line-ChannelToken')).toBe('channel-token');
    expect(header(photo!, 'X-Line-Mid')).toBe(GROUP);
    expect(header(photo!, 'X-Line-Album')).toBe('album-1');
    expect(header(photo!, 'X-Line-Access')).toBe('account-token');
    expect(header(photo!, 'X-Line-Application')).toBeUndefined();
    expect(photo!.headers.map(([n]) => n)).toEqual(['User-Agent', 'X-Line-ChannelToken', 'X-Line-Mid', 'X-Line-Album', 'X-Line-Access']);
    expect(server.requests).toHaveLength(2);
  });

  it('sends the access token that is current after the channel token wait', async () => {
    const callbacks: Array<() => void> = [];
    const recordingTimers = { set: (callback: () => void) => { callbacks.push(callback); return callbacks.length; }, clear: () => undefined };
    const clock = { t: NOW };
    const { adapter, server } = await build({ timers: recordingTimers, now: () => clock.t });
    clock.t = NOW + 3_700_000; // the stored expiry has passed
    server.on('/api/auth/tokenRefresh', ok({ accessToken: 'token-2', refreshToken: 'refresh-2', tokenIssueTimeEpochSec: '1700000000',
      durationUntilRefreshInSec: '3600' }));
    server.on(CHANNEL_TOKEN_PATH, async () => {
      callbacks[0]!(); // the refresh timer fires while issueChannelToken is in flight
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      return tokenReply();
    });
    server.on('/r/album/a/oid-1/f482x482', new Response('x'));
    await adapter.readChatResource(download(), { signal: signal() });
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
    expect(server.to(CHANNEL_TOKEN_PATH)).toHaveLength(1);
    expect(header(server.to(CHANNEL_TOKEN_PATH)[0]!, 'X-Line-Access')).toBe('account-token');
    expect(header(server.to('/r/album/a/oid-1/f482x482')[0]!, 'X-Line-Access')).toBe('token-2');
  });

  it('caches the channel token across downloads', async () => {
    const { adapter, server } = await build();
    server.on(CHANNEL_TOKEN_PATH, tokenReply('t1'), tokenReply('t2'));
    server.on('/r/album/a/oid-1/f482x482', new Response('a'), new Response('b'));
    await adapter.readChatResource(download(), { signal: signal() });
    await adapter.readChatResource(download(), { signal: signal() });
    expect(server.to(CHANNEL_TOKEN_PATH)).toHaveLength(1);
    expect(server.to('/r/album/a/oid-1/f482x482').map((request) => header(request, 'X-Line-ChannelToken'))).toEqual(['t1', 't1']);
  });

  it('keeps the cached token after a failed read (line-cli methods.go:776-784)', async () => {
    const { adapter, server } = await build();
    server.on(CHANNEL_TOKEN_PATH, tokenReply('t1'), tokenReply('t2'));
    server.on('/r/album/a/oid-1/f482x482', new Response('', { status: 404 }), new Response('ok'));
    await expect(adapter.readChatResource(download(), { signal: signal() })).rejects.toMatchObject({
      name: 'ChatResourceFailure', category: 'list_get_transport_failure', upstreamStatus: 404 });
    await adapter.readChatResource(download(), { signal: signal() });
    expect(server.to(CHANNEL_TOKEN_PATH)).toHaveLength(1);
    expect(header(server.to('/r/album/a/oid-1/f482x482')[1]!, 'X-Line-ChannelToken')).toBe('t1');
  });

  it('works in monitor mode (a read) and still denies a cross-type chat id', async () => {
    const { adapter, server } = await build({ mode: 'MONITOR_ONLY' });
    server.on(CHANNEL_TOKEN_PATH, tokenReply());
    server.on('/r/album/a/oid-1/f482x482', new Response('x'));
    await expect(adapter.readChatResource(download(), { signal: signal() })).resolves.toMatchObject({ bytes: expect.anything() });
    await expect(adapter.readChatResource(download({ chatType: 'direct' }), { signal: signal() })).rejects.toBeInstanceOf(EffectDeniedError);
  });

  it('maps failures: bootstrap, HTTP status, size limit, no token', async () => {
    let harness = await build();
    harness.server.on(CHANNEL_TOKEN_PATH, new Response(JSON.stringify({ code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 5 } }), { status: 400 }));
    await expect(harness.adapter.readChatResource(download(), { signal: signal() })).rejects.toMatchObject({
      category: 'bootstrap_failure', upstreamStatus: 400, upstreamCode: 5 });

    harness = await build();
    harness.server.on(CHANNEL_TOKEN_PATH, ok({ channelAccessToken: '' }));
    await expect(harness.adapter.readChatResource(download(), { signal: signal() })).rejects.toMatchObject({ category: 'bootstrap_failure' });

    harness = await build();
    harness.server.on(CHANNEL_TOKEN_PATH, tokenReply());
    harness.server.on('/r/album/a/oid-1/f482x482', new Response('', { status: 404 }));
    await expect(harness.adapter.readChatResource(download(), { signal: signal() })).rejects.toMatchObject({ category: 'list_get_transport_failure', upstreamStatus: 404 });

    harness = await build();
    harness.server.on(CHANNEL_TOKEN_PATH, tokenReply());
    harness.server.on('/r/album/a/oid-1/f482x482', new Response('way too long'));
    await expect(harness.adapter.readChatResource(download({ maxBytes: 4 }), { signal: signal() })).rejects.toMatchObject({ category: 'response_validation' });

    harness = await build({ loggedIn: false });
    await expect(harness.adapter.readChatResource(download(), { signal: signal() })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(harness.server.requests).toHaveLength(0);
  });

  it('sends nothing once cancelled or revoked', async () => {
    const { adapter, server } = await build();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(adapter.readChatResource(download(), { signal: controller.signal })).rejects.toThrow('cancelled');
    adapter.revoke();
    await expect(adapter.readChatResource(download(), { signal: signal() })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(server.requests).toHaveLength(0);
  });
});

describe('ChromeAdapter.readChatResource: unsupported actions', () => {
  const unsupported: Array<[string, Partial<Command>]> = [
    ['listNotes', { action: 'listNotes' }],
    ['getNote', { action: 'getNote', postId: 'p1' }],
    ['listAlbums', { action: 'listAlbums' }],
    ['listAlbumPhotos', { action: 'listAlbumPhotos', albumId: 'album-1' }],
    ['downloadAlbumPhoto of a video', { prefix: 'album/v' }],
  ];
  for (const [name, over] of unsupported) {
    it(`${name} is ChatResourceUnsupportedError and sends nothing`, async () => {
      const { adapter, server } = await build();
      await expect(adapter.readChatResource(download(over), { signal: signal() })).rejects.toBeInstanceOf(ChatResourceUnsupportedError);
      expect(server.requests).toHaveLength(0);
    });
  }
  it('answers unsupported even before login', async () => {
    const { adapter } = await build({ loggedIn: false });
    await expect(adapter.readChatResource(download({ action: 'listNotes' }), { signal: signal() })).rejects.toBeInstanceOf(ChatResourceUnsupportedError);
  });
});

describe('ChromeAdapter.readChatResource through LineWorkerLoop', () => {
  async function start() {
    const harness = await build();
    harness.server.on('/api/talk/thrift/Talk/TalkService/getProfile', ok({ mid: SELF, displayName: 'Agent', picturePath: '/0h' }),
      ok({ mid: SELF, displayName: 'Agent', picturePath: '/0h' }));
    const events: LineWorkerEvent[] = [];
    const worker = new LineWorkerLoop({ transport: harness.adapter, emit: (event) => { events.push(LineWorkerEventSchema.parse(event)); }, validateLease: () => true });
    await worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor0, lineTransport: 'CHROMEOS' });
    await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1', secrets: { token: 'account-token', qrCert: null, e2eeStorage: snapshot() } });
    harness.server.on('/api/talk/thrift/Talk/TalkService/getAllChatMids', ok({ memberChatMids: [], invitedChatMids: [] }));
    harness.server.on('/api/talk/thrift/Talk/TalkService/getMessageBoxes', ok({ messageBoxes: [], hasNext: false }));
    await worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { ...harness, worker, events };
  }
  const read = (over: Record<string, unknown>) => ({ type: 'chatResourceRead' as const, ...binding, chatType: 'group' as const, chatId: GROUP,
    timeoutMs: 10_000, ...over });

  it('emits UNSUPPORTED for notes and album listing, which Main and the renderer map to "not supported by this login"', async () => {
    const { worker, events } = await start();
    for (const [requestId, action, extra] of [['n1', 'listNotes', {}], ['n2', 'getNote', { postId: 'p' }], ['a1', 'listAlbums', {}],
      ['a2', 'listAlbumPhotos', { albumId: 'x' }]] as const) {
      await worker.handle(read({ requestId, action, ...extra }));
      expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', requestId, action, ok: false, error: 'UNSUPPORTED' });
    }
  });

  it('returns the photo bytes in the same result shape as the DESKTOPWIN transport', async () => {
    const { worker, events, server } = await start();
    server.on(CHANNEL_TOKEN_PATH, tokenReply());
    server.on('/r/album/a/oid-1/f482x482', new Response(new Uint8Array([9, 8, 7])));
    const command = read({ requestId: 'p1', action: 'downloadAlbumPhoto', albumId: 'album-1', photoId: 'photo-1', oid: 'oid-1', prefix: 'album/a', maxBytes: 1024 });
    await worker.handle(command);
    const chrome = events.at(-1)!;
    expect(chrome).toMatchObject({ type: 'chatResourceResult', requestId: 'p1', action: 'downloadAlbumPhoto', ok: true, error: null });

    // The DESKTOPWIN-side fake produces the same event for equivalent data.
    const desktop = new FakeLineTransport({ ownMid: SELF, displayName: 'Agent' });
    const desktopEvents: LineWorkerEvent[] = [];
    const desktopWorker = new LineWorkerLoop({ transport: desktop, emit: (event) => { desktopEvents.push(LineWorkerEventSchema.parse(event)); }, validateLease: () => true });
    await desktopWorker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor0 });
    await desktopWorker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    desktop.enqueueChatResource({ bytes: new Uint8Array([9, 8, 7]) });
    await desktopWorker.handle(command);
    const other = desktopEvents.at(-1)!;
    expect(Object.keys(chrome).sort()).toEqual(Object.keys(other).sort());
    expect(Array.from((chrome as { bytes: Uint8Array }).bytes)).toEqual(Array.from((other as { bytes: Uint8Array }).bytes));
  });

  it('reports a failed download with the same bounded failure fields as DESKTOPWIN', async () => {
    const { worker, events, server } = await start();
    server.on(CHANNEL_TOKEN_PATH, tokenReply());
    server.on('/r/album/a/oid-1/f482x482', new Response('', { status: 403 }));
    await worker.handle(read({ requestId: 'p2', action: 'downloadAlbumPhoto', albumId: 'album-1', photoId: 'photo-1', oid: 'oid-1', prefix: 'album/a', maxBytes: 1024 }));
    expect(events.at(-1)).toMatchObject({ type: 'chatResourceResult', requestId: 'p2', ok: false, error: 'list_get_transport_failure', upstreamStatus: 403 });
    expect(new ChatResourceFailure('response_validation').category).toBe('response_validation');
  });
});
