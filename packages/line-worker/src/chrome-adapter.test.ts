import { describe, expect, it } from 'vitest';
import { FakeHmacSigner, CHROME_TRANSPORT_TAG, type ReceiveClock } from '@line-agent/line-chrome';
import { LineWorkerEventSchema, type LineWorkerEvent } from '@line-agent/contracts';
import {
  ChromeForeignCursorError, ChromeReceiverDisconnectedError, CATCHUP_MAX_CHATS,
  createChromeAdapter, type ChromeAdapter, type ChromeAdapterBridge,
} from './chrome-adapter.js';
import { EffectDeniedError } from './mutation-gate.js';
import { fetchLinejsConversationCatalog, normalizeLinePicturePath } from './linejs-adapter.js';
import { LineWorkerLoop } from './worker-loop.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const SELF = `u${'a'.repeat(32)}`;
const PEER = `u${'b'.repeat(32)}`;
const GROUP = `c${'c'.repeat(32)}`;
const cursor0 = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const NOW = 1_700_000_000_000;

// -- fakes ----------------------------------------------------------------------------------------------------------

const ok = (data: unknown): Response => new Response(JSON.stringify({ message: 'OK', data }), { status: 200 });
const failure = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function flush(rounds = 12): Promise<void> { for (let i = 0; i < rounds; i += 1) await tick(); }

type Reply = Response | Error | (() => Response | Promise<Response>);
type Recorded = { url: string; path: string; method: string; headers: Array<[string, string]>; body: string | undefined };
class FakeServer {
  readonly requests: Recorded[] = [];
  private readonly queues = new Map<string, Reply[]>();
  private readonly fixed = new Map<string, Reply>();
  on(path: string, ...replies: Reply[]): this { this.queues.set(path, [...(this.queues.get(path) ?? []), ...replies]); return this; }
  always(path: string, reply: Reply): this { this.fixed.set(path, reply); return this; }
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    this.requests.push({ url, path, method: init.method ?? 'GET',
      headers: (init.headers as Array<[string, string]>).map(([name, value]) => [name, value]), body: init.body as string | undefined });
    const next = this.queues.get(path)?.shift() ?? this.fixed.get(path);
    if (next === undefined) throw new Error(`unexpected request to ${path}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  to(path: string): Recorded[] { return this.requests.filter((request) => request.path === path); }
  bodies(path: string): unknown[] { return this.to(path).map((request) => JSON.parse(request.body ?? 'null')); }
}
const tp = (method: string): string => `/api/talk/thrift/Talk/TalkService/${method}`;
const QR = (method: string): string => `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/${method}`;
const QR_NOTICE = (method: string): string => `/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/${method}`;
const LOGOUT = '/api/talk/thrift/Talk/AuthService/logoutV2';
const SSE = '/api/operation/receive';

class FakeSseStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  closed = false;
  readonly response: Response;
  constructor() {
    this.response = new Response(new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      cancel: () => { this.closed = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  write(data: unknown): void { this.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); }
}

/** Timers that never fire: the SSE watchdog and the token refresh timer stay inert. */
const inertClock: ReceiveClock = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => undefined };
/**
 * While `fast` is true, every timer fires at once: the backoff sleeps end immediately, so 144 failed opens end in 'disconnected'
 * without real waiting. Set `fast` to false before a stream opens, or its silence watchdog fires at once too.
 */
function instantBackoffClock(): ReceiveClock & { fast: boolean } {
  const clock = { fast: true, now: () => NOW, clearTimeout: () => undefined,
    setTimeout: (callback: () => void) => { if (clock.fast) queueMicrotask(callback); return 0; } };
  return clock;
}
function fakeTimers() {
  const scheduled: Array<{ ms: number; callback: () => void }> = [];
  return { scheduled, api: { set: (callback: () => void, ms: number) => { scheduled.push({ ms, callback }); return scheduled.length; }, clear: () => undefined } };
}

function fakeBridge(): ChromeAdapterBridge & { calls: string[] } {
  const calls: string[] = [];
  const unexpected = (name: string) => async () => { calls.push(name); throw new Error(`unexpected bridge call ${name}`); };
  return {
    calls,
    curveKeyGenerate: async () => { calls.push('curveKeyGenerate'); return 7; },
    e2eePublicKey: async () => 'cHVi+/a2V5PQ==',
    e2eeCreateChannel: async () => 70,
    e2eeUnwrapKeychain: async () => [101],
    e2eeGetKeyId: async () => 1000,
    e2eeExportKey: async (handle: number) => `blob-${handle}`,
    e2eeLoadKey: async () => 101,
    e2eePublicKeyForHandle: unexpected('e2eePublicKeyForHandle'),
    e2eeCreateChannelWithPubkey: unexpected('e2eeCreateChannelWithPubkey'),
    e2eeEncryptV1: unexpected('e2eeEncryptV1'), e2eeEncryptV2: unexpected('e2eeEncryptV2'),
    e2eeDecryptV1: unexpected('e2eeDecryptV1'), e2eeDecryptV2: unexpected('e2eeDecryptV2'),
    e2eeWrapGroupSharedKey: unexpected('e2eeWrapGroupSharedKey'), e2eeUnwrapGroupSharedKey: unexpected('e2eeUnwrapGroupSharedKey'),
  } as unknown as ChromeAdapterBridge & { calls: string[] };
}

const LOGIN_RESULT = {
  tokenV3IssueResult: { accessToken: 'access-1', refreshToken: 'refresh-1', tokenIssueTimeEpochSec: '1700000000',
    durationUntilRefreshInSec: '3600', refreshApiRetryPolicy: { initialDelayInMillis: '1000', maxDelayInMillis: '30000', multiplier: '2', jitterRate: '0.1' } },
  certificate: 'cert-1', mid: SELF, metaData: { publicKey: 'c2VydmVy', encryptedKeyChain: 'Y2hhaW4=' },
};
const PROFILE = { mid: SELF, displayName: 'Agent', picturePath: '/0hAbCdEf', regionCode: 'JP' };

const snapshot = (extra: Record<string, unknown> = {}) => ({ transport: CHROME_TRANSPORT_TAG, refreshToken: 'refresh-0',
  tokenIssueTimeEpochSec: 1_700_000_000, durationUntilRefreshInSec: 3600, mid: SELF, ...extra });

async function build(options: { mode?: 'MONITOR_ONLY' | 'ACTIVE_CONTROL' | 'PAUSED'; server?: FakeServer; waitMs?: number; signer?: FakeHmacSigner; receiveClock?: ReceiveClock } = {}) {
  const server = options.server ?? new FakeServer();
  const timers = fakeTimers();
  const bridge = fakeBridge();
  const clock = { t: NOW };
  const adapter = await createChromeAdapter({
    ...binding, mode: options.mode ?? 'MONITOR_ONLY', validateLease: () => true, fetch: server.fetch,
    signer: options.signer ?? new FakeHmacSigner(), bridge, receiveClock: options.receiveClock ?? inertClock, receiveWaitMs: options.waitMs ?? 0,
    timers: timers.api, now: () => clock.t,
  });
  const events: Array<{ event: string; value: unknown }> = [];
  for (const event of ['qr', 'pin', 'token', 'qrCert', 'storage', 'credentials', 'authInvalidated', 'refreshFailure'] as const) {
    adapter.on(event, (value) => { events.push({ event, value }); });
  }
  return { server, adapter, timers, bridge, events, clock };
}

function quietCatalog(server: FakeServer): void {
  server.always(tp('getAllChatMids'), () => ok({ memberChatMids: [], invitedChatMids: [] }));
  server.always(tp('getMessageBoxes'), () => ok({ messageBoxes: [], hasNext: false }));
}

// -- login / secrets / logout ----------------------------------------------------------------------------------------

describe('ChromeAdapter login and credentials', () => {
  it('runs the QR login, reports the worker events and returns the normalised identity', async () => {
    const { adapter, server, events, timers } = await build();
    server.on(QR('createSession'), ok({ authSessionId: 'sid' }));
    server.on(QR('createQrCode'), ok({ callbackUrl: 'https://line.me/R/au/q/abc', longPollingIntervalSec: 10, longPollingMaxCount: 12 }));
    server.on(QR_NOTICE('checkQrCodeVerified'), ok({}));
    server.on(QR('verifyCertificate'), failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 9 } }));
    server.on(QR('createPinCode'), ok({ pinCode: '4321' }));
    server.on(QR_NOTICE('checkPinCodeVerified'), ok({}));
    server.on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
    server.on(tp('getProfile'), ok(PROFILE));

    const identity = await adapter.loginQr();

    expect(identity).toEqual({ ownMid: SELF, displayName: 'Agent', picturePath: normalizeLinePicturePath('/0hAbCdEf') });
    expect(events.map((entry) => entry.event)).toEqual(['qr', 'pin', 'qrCert', 'storage', 'token', 'storage']); // the last one records the profile region
    expect(String(events[0]!.value)).toMatch(/secret=.*&e2eeVersion=1$/);
    expect(events[1]!.value).toBe('4321');
    expect(events.find((entry) => entry.event === 'token')!.value).toBe('access-1');
    const stored = events.find((entry) => entry.event === 'storage')!.value as Record<string, unknown>;
    expect(stored.transport).toBe(CHROME_TRANSPORT_TAG);
    expect(stored.refreshToken).toBe('refresh-1');
    // Gateway RPCs carry neither X-Line-Application nor a cookie; only getProfile carries the new token.
    for (const request of server.requests) {
      expect(request.headers.map(([name]) => name.toLowerCase())).not.toContain('x-line-application');
      expect(request.headers.map(([name]) => name.toLowerCase())).not.toContain('cookie');
    }
    expect(server.to(QR('createSession'))[0]!.headers.map(([name]) => name)).not.toContain('X-Line-Access');
    expect(server.to(tp('getProfile'))[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('access-1');
    // The refresh timer is armed at (issue + duration) - now.
    expect(timers.scheduled.map((entry) => entry.ms)).toEqual([3_600_000 - 0]);
  });

  it('signs every QR login call with the empty token even when an old token is installed', async () => {
    const signer = new FakeHmacSigner();
    const { adapter, server } = await build({ signer });
    await adapter.installSecrets({ token: 'old-token', qrCert: null, e2eeStorage: snapshot() });
    server.on(QR('createSession'), ok({ authSessionId: 'sid' }));
    server.on(QR('createQrCode'), ok({ callbackUrl: 'https://line.me/R/au/q/abc', longPollingIntervalSec: 10, longPollingMaxCount: 12 }));
    server.on(QR_NOTICE('checkQrCodeVerified'), ok({}));
    server.on(QR('verifyCertificate'), failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 9 } }));
    server.on(QR('createPinCode'), ok({ pinCode: '4321' }));
    server.on(QR_NOTICE('checkPinCodeVerified'), ok({}));
    server.on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
    server.on(tp('getProfile'), ok(PROFILE));

    await adapter.loginQr();

    const loginCalls = signer.calls.filter((call) => call.pathWithQuery.includes('/LoginQrCode/'));
    expect(loginCalls.length).toBe(7);
    expect(loginCalls.every((call) => call.accessToken === '')).toBe(true);
    for (const request of server.requests.filter((entry) => entry.path.includes('/LoginQrCode/'))) {
      expect(request.headers.map(([name]) => name)).not.toContain('X-Line-Access');
    }
  });

  function queueQrLogin(server: FakeServer, onVerified: () => Response | Promise<Response>): void {
    server.on(QR('createSession'), ok({ authSessionId: 'sid' }));
    server.on(QR('createQrCode'), ok({ callbackUrl: 'https://line.me/R/au/q/abc', longPollingIntervalSec: 10, longPollingMaxCount: 12 }));
    server.on(QR_NOTICE('checkQrCodeVerified'), onVerified);
    server.on(QR('verifyCertificate'), failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 9 } }));
    server.on(QR('createPinCode'), ok({ pinCode: '4321' }));
    server.on(QR_NOTICE('checkPinCodeVerified'), ok({}));
    server.on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
    server.on(tp('getProfile'), ok(PROFILE));
  }

  it('QR login stops the old refresh timer: a timer that fires during the scan sends no tokenRefresh', async () => {
    const signer = new FakeHmacSigner();
    const { adapter, server, timers, clock, events } = await build({ signer });
    await adapter.installSecrets({ token: 'old-token', qrCert: null, e2eeStorage: snapshot() });
    clock.t = NOW + 3_700_000; // the stored expiry has passed
    queueQrLogin(server, () => { timers.scheduled[0]!.callback(); return ok({}); });
    await adapter.loginQr();
    await flush();
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(0);
    const loginCalls = signer.calls.filter((call) => call.pathWithQuery.includes('/LoginQrCode/'));
    expect(loginCalls).toHaveLength(7);
    expect(loginCalls.every((call) => call.accessToken === '')).toBe(true);
    expect(events.filter((entry) => entry.event === 'refreshFailure')).toHaveLength(0);
  });

  it('QR login discards a refresh that is in flight: no credentials event, login calls stay signed with the empty token', async () => {
    const signer = new FakeHmacSigner();
    const { adapter, server, timers, clock, events } = await build({ signer });
    await adapter.installSecrets({ token: 'old-token', qrCert: null, e2eeStorage: snapshot() });
    clock.t = NOW + 3_700_000;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    server.on('/api/auth/tokenRefresh', async () => { await released; return ok({ accessToken: 'tok-late', refreshToken: 'refresh-late',
      tokenIssueTimeEpochSec: '1700000000', durationUntilRefreshInSec: '3600' }); });
    timers.scheduled[0]!.callback(); // the refresh POST starts
    await flush();
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
    queueQrLogin(server, () => { release(); return ok({}); });
    await adapter.loginQr();
    await flush();
    expect(events.filter((entry) => entry.event === 'credentials')).toHaveLength(0);
    expect(events.filter((entry) => entry.event === 'refreshFailure')).toHaveLength(0);
    const loginCalls = signer.calls.filter((call) => call.pathWithQuery.includes('/LoginQrCode/'));
    expect(loginCalls).toHaveLength(7);
    expect(loginCalls.every((call) => call.accessToken === '')).toBe(true);
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
  });

  it('resumes from the three secret slots and rejects a foreign snapshot without touching state', async () => {
    const { adapter, server } = await build();
    await expect(adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: { expire: 1, refreshToken: 'x', 'chrome:reqSeq': 3 } }))
      .rejects.toThrow(/transport/);
    await expect(adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: { ...snapshot(), transport: 'CHROMEOS-3.7.1' } })).rejects.toThrow();
    server.on(tp('getProfile'), ok(PROFILE));
    await adapter.installSecrets({ token: 'tok', qrCert: 'cert', e2eeStorage: snapshot() });
    const identity = await adapter.loginToken('tok');
    expect(identity.ownMid).toBe(SELF);
    expect(server.to(tp('getProfile'))[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok');
    expect(server.bodies(tp('getProfile'))).toEqual([[2]]);
  });

  it('logs out through logoutV2 once and stops the stream and timers', async () => {
    const { adapter, server } = await build();
    server.on(LOGOUT, ok(null));
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    await adapter.logoutServer();
    expect(server.bodies(LOGOUT)).toEqual([[]]);
    expect(server.to(LOGOUT)[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok');
    expect(adapter.receiverState.kind).toBe('stopped');
    expect(adapter.reconnectReceiver()).toBe(false);
    await expect(adapter.logoutServer()).rejects.toBeInstanceOf(EffectDeniedError);
  });

  it('turns a dead session during a read into authInvalidated', async () => {
    const { adapter, server, events } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    server.on(tp('getProfile'), failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 8, reason: 'x' } }));
    await expect(adapter.refreshOwnProfile()).rejects.toThrow();
    expect(events.filter((entry) => entry.event === 'authInvalidated')).toHaveLength(1);
    expect(server.to(tp('getProfile'))).toHaveLength(1);
  });

  it('a tokenRefresh answer with nested data.code 10201 stops the receiver and invalidates the auth once', async () => {
    const { adapter, server, events, timers, clock } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    clock.t = NOW + 3_700_000;
    server.on('/api/auth/tokenRefresh', failure(400, { message: 'FAILED', data: { code: 10201 } }));
    timers.scheduled[0]!.callback();
    await flush();
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'authInvalidated')).toHaveLength(1);
    expect(adapter.receiverState.kind).toBe('stopped');
  });

  it('a 10201 envelope on a read is a plain failure: no authInvalidated, receiver state unchanged', async () => {
    const { adapter, server, events } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const before = adapter.receiverState.kind;
    server.on(tp('getProfile'), failure(400, { code: 10201, message: 'x' }));
    await expect(adapter.refreshOwnProfile()).rejects.toThrow();
    expect(events.filter((entry) => entry.event === 'authInvalidated')).toHaveLength(0);
    expect(adapter.receiverState.kind).toBe(before);
    expect(server.to(tp('getProfile'))).toHaveLength(1);
  });

  it('treats data.code true as TalkException 1: authInvalidated once, receiver stopped, no refresh POST', async () => {
    const { adapter, server, events } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    server.on(tp('getProfile'), failure(200, { message: 'FAILED', data: { code: true } }));
    await expect(adapter.refreshOwnProfile()).rejects.toThrow();
    expect(events.filter((entry) => entry.event === 'authInvalidated')).toHaveLength(1);
    expect(adapter.receiverState.kind).toBe('stopped');
    expect(server.to(tp('getProfile'))).toHaveLength(1);
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(0);
  });

  it('a text/html 400 body with a leading space is not parsed: no authInvalidated, receiver state unchanged', async () => {
    const { adapter, server, events } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const before = adapter.receiverState.kind;
    server.on(tp('getProfile'), new Response(' {"error":{"code":1}}', { status: 400, headers: { 'content-type': 'text/html' } }));
    await expect(adapter.refreshOwnProfile()).rejects.toThrow();
    expect(events.filter((entry) => entry.event === 'authInvalidated')).toHaveLength(0);
    expect(adapter.receiverState.kind).toBe(before);
    expect(server.to(tp('getProfile'))).toHaveLength(1);
  });

  it('implements the write operations and leaves the DESKTOPWIN-only optional ones undefined', async () => {
    const { adapter } = await build();
    const loose = adapter as unknown as Record<string, unknown>;
    for (const name of ['send', 'sendMedia', 'download', 'react', 'unsend', 'checkFriendRelation', 'checkFriendRelationDiagnostic', 'addFriendByMid', 'readChatResource']) {
      expect(typeof loose[name]).toBe('function');
    }
    for (const name of ['adoptDownloadAuth', 'clearDownloadAuth']) expect(loose[name]).toBeUndefined();
  });
});

// -- listConversations ----------------------------------------------------------------------------------------------

describe('ChromeAdapter.listConversations', () => {
  const U1 = `u${'1'.repeat(32)}`;
  const U2 = `u${'2'.repeat(32)}`;
  const GROUP1 = `c${'3'.repeat(32)}`;
  const ROOM1 = `r${'4'.repeat(32)}`;
  const contacts = {
    [U1]: { contact: { displayName: 'Alice', displayNameOverridden: 'Ali', picturePath: '/0hAlice' } },
    [U2]: { contact: { displayName: 'Bob' } },
  };
  const chats = [
    { chatMid: GROUP1, chatName: 'The Group', picturePath: '/0hGroup', extra: { groupExtra: { memberMids: { [U2]: 1, [U1]: 2 } } } },
    { chatMid: ROOM1, chatName: '', extra: { groupExtra: { memberMids: { [U2]: 1 } } } },
  ];

  it('matches the DESKTOPWIN catalog for equivalent data and sends the registry argument shapes', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    server.on(tp('getAllChatMids'), ok({ memberChatMids: [GROUP1, ROOM1], invitedChatMids: [] }));
    server.on(tp('getMessageBoxes'), ok({ messageBoxes: [{ id: U1 }, { id: GROUP1 }], hasNext: false }));
    server.on(tp('getChats'), ok({ chats }));
    server.on(tp('getContactsV2'), ok({ contacts }));

    const actual = await adapter.listConversations();

    const reference = await fetchLinejsConversationCatalog({
      ownMid: SELF,
      getAllChatMids: async () => ({ memberChatMids: [GROUP1, ROOM1] }),
      getMessageBoxes: async () => ({ messageBoxes: [{ id: U1 }, { id: GROUP1 }] }),
      getChats: async () => ({ chats }),
      getContactsV2: async () => ({ contacts }),
    }, (call) => call());
    expect(actual).toEqual(reference);
    expect(actual.map((item) => [item.chatType, item.chatId])).toEqual([['direct', U1], ['group', GROUP1], ['room', ROOM1]]);

    expect(server.bodies(tp('getAllChatMids'))).toEqual([[{ withMemberChats: true, withInvitedChats: true }, 4]]);
    const [boxRequest] = server.bodies(tp('getMessageBoxes')) as Array<[Record<string, unknown>, number]>;
    expect(boxRequest![1]).toBe(2);
    expect(boxRequest![0]).toMatchObject({ minChatId: null, activeOnly: true, messageBoxCountLimit: 100 });
    expect(server.bodies(tp('getChats'))).toEqual([[{ chatMids: [GROUP1, ROOM1], withMembers: true, withInvitees: true }, 4]]);
    expect(server.bodies(tp('getContactsV2'))).toEqual([[{ targetUserMids: [U1, U2], neededContactCalendarEvents: [] }, 4]]);
  });

  it('pages message boxes and chunks chats and contacts by 100', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const hex = (n: number): string => n.toString(16).padStart(32, '0');
    const groups = Array.from({ length: 101 }, (_, index) => `c${hex(index)}`);
    server.on(tp('getAllChatMids'), ok({ memberChatMids: [], invitedChatMids: [] }));
    server.on(tp('getMessageBoxes'), ok({ messageBoxes: groups.slice(0, 60).map((id) => ({ id })), hasNext: true }),
      ok({ messageBoxes: groups.slice(60).map((id) => ({ id })), hasNext: false }));
    const chatPages: string[][] = [];
    server.always(tp('getChats'), async () => {
      const mids = (JSON.parse(server.requests.at(-1)!.body!) as [{ chatMids: string[] }, number])[0].chatMids;
      chatPages.push(mids);
      return ok({ chats: mids.map((chatMid, index) => ({ chatMid, chatName: `G${index}`, extra: { groupExtra: { memberMids: { [`u${hex(chatPages.length * 1000 + index)}`]: 1 } } } })) });
    });
    server.always(tp('getContactsV2'), () => ok({ contacts: {} }));

    const result = await adapter.listConversations();

    expect(result).toHaveLength(101);
    expect((server.bodies(tp('getMessageBoxes')) as Array<[{ minChatId: string | null }]>).map((body) => body[0].minChatId)).toEqual([null, groups[59]]);
    expect(chatPages.map((page) => page.length)).toEqual([100, 1]);
    const contactPages = (server.bodies(tp('getContactsV2')) as Array<[{ targetUserMids: string[] }]>).map((body) => body[0].targetUserMids.length);
    expect(contactPages).toEqual([100, 1]);
  });
});

describe('ChromeAdapter.refreshOwnProfile', () => {
  it('reads getProfile [2] and normalises the picture path like the DESKTOPWIN adapter', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    server.on(tp('getProfile'), ok({ ...PROFILE, mid: SELF.toUpperCase().replace('U', 'u') , picturePath: '/0hNew' }));
    const identity = await adapter.refreshOwnProfile();
    expect(identity).toEqual({ ownMid: SELF, displayName: 'Agent', picturePath: normalizeLinePicturePath('/0hNew') });
    expect(server.bodies(tp('getProfile'))).toEqual([[2]]);
  });
  it('refuses without a token', async () => {
    const { adapter } = await build();
    await expect(adapter.refreshOwnProfile()).rejects.toThrow(/unavailable/);
  });
});

// -- sync -----------------------------------------------------------------------------------------------------------

const text = (id: number, over: Record<string, unknown> = {}) => ({ id: String(id), from: PEER, to: GROUP, toType: 2, contentType: 0,
  text: `m${id}`, createdTime: 1_700_000_000_000 + id, ...over });
const receive = (revision: number, message: Record<string, unknown>) => ({ revision, type: 26, createdTime: 1_700_000_000_000, message });
const readOp = (revision: number, chat: string, messageId: string) => ({ revision, type: 55, createdTime: 1_700_000_000_000,
  param1: chat, param2: PEER, param3: messageId });
const chatMid = (n: number): string => `c${n.toString(16).padStart(32, '0')}`;

async function openStream(server: FakeServer, adapter: ChromeAdapter, rev = '0'): Promise<FakeSseStream> {
  const stream = new FakeSseStream();
  server.on(SSE, () => stream.response);
  server.always(tp('getLastOpRevision'), () => ok(100));
  await adapter.sync({ ...cursor0, revision: rev });
  await flush();
  return stream;
}

describe('ChromeAdapter.sync', () => {
  it('starts the stream at the durable cursor, drains it and strips the catch-up list', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '40');
    const opened = server.to(SSE)[0]!;
    expect(opened.url).toContain('version=3.7.2&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=40');
    expect(opened.headers.map(([name]) => name)).toEqual(['accept', 'cache-control', 'Accept-Language', 'User-Agent', 'X-Line-Access', 'X-Hmac']);
    stream.write([receive(41, text(41)), receive(42, text(42))]);
    await flush();
    const result = await adapter.sync({ ...cursor0, revision: '40' });
    expect(result.cursorAfter).toEqual({ version: 1, revision: '42', globalRev: '0', individualRev: '0' });
    expect(result.operations).toHaveLength(2);
    expect(Object.keys(result)).not.toContain('catchupChatIds');
    // The cursor is the ack: the same cursor replays, a later one drops.
    expect((await adapter.sync({ ...cursor0, revision: '40' })).operations).toHaveLength(2);
    expect((await adapter.sync({ ...cursor0, revision: '42' })).operations).toHaveLength(0);
  });

  it('catches up a first-sighted chat once, newest-first rows delivered oldest-first, capped at 5 chats x 20', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    const chats = Array.from({ length: 7 }, (_, index) => chatMid(index + 1));
    server.always(tp('getRecentMessagesV2'), async () => {
      const [chat, count] = JSON.parse(server.requests.at(-1)!.body!) as [string, number];
      return ok(Array.from({ length: count }, (_, index) => text(1000 - index, { to: chat })));
    });
    stream.write(chats.map((chat, index) => readOp(101 + index, chat, '55')));
    await flush();

    const result = await adapter.sync({ ...cursor0, revision: '100' });

    const calls = server.bodies(tp('getRecentMessagesV2'));
    expect(CATCHUP_MAX_CHATS).toBe(5);
    expect(calls).toEqual(chats.slice(0, 5).map((chat) => [chat, 20]));
    expect(result.operations).toHaveLength(100);
    const first = result.operations[0] as { source: string; operation: { revision: string; message: { id: string } } };
    expect(first.source).toBe('history');
    expect(first.operation.message.id).toBe('981'); // oldest of the 20 rows first
    expect(result.readReceipts).toHaveLength(7);
    // Same policy as DESKTOPWIN: the two chats beyond the cap stay seen, so a later receipt does not catch them up.
    stream.write([readOp(108, chats[5]!, '56')]);
    await flush();
    await adapter.sync({ ...cursor0, revision: '107' });
    expect(server.bodies(tp('getRecentMessagesV2'))).toHaveLength(5);
  });

  it('keeps the catch-up items that do not fit in the batch and delivers them at the next sync, with one read in total', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    const chat = chatMid(20);
    server.always(tp('getRecentMessagesV2'), () => ok(Array.from({ length: 20 }, (_, index) => text(2000 - index, { to: chat }))));
    // 99 live messages and one read receipt fill the batch to 100 operations; the live items leave room for one catch-up item.
    stream.write([...Array.from({ length: 99 }, (_, index) => receive(101 + index, text(101 + index))), readOp(200, chat, '9')]);
    await flush();

    const first = await adapter.sync({ ...cursor0, revision: '100' });
    expect(first.operations).toHaveLength(100); // 99 live + 1 catch-up item
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(1);

    const second = await adapter.sync({ ...cursor0, revision: '200' });
    expect(second.operations).toHaveLength(19); // the rest of the same catch-up, without a second read
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(1);
    const third = await adapter.sync({ ...cursor0, revision: '200' });
    expect(third.operations).toHaveLength(0);
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(1);
  });

  it('forgets a chat whose catch-up failed so its next receipt retries', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    const chat = chatMid(9);
    server.on(tp('getRecentMessagesV2'), failure(400, { code: 10052, message: 'RESPONSE_HTTP_ERROR', data: { statusCode: 403 } }),
      ok([text(7, { to: chat })]));
    stream.write([readOp(101, chat, '5')]);
    await flush();
    const first = await adapter.sync({ ...cursor0, revision: '100' });
    expect(first.operations).toEqual([]);
    expect(first.readReceipts).toHaveLength(1);
    stream.write([readOp(102, chat, '6')]);
    await flush();
    const second = await adapter.sync({ ...cursor0, revision: '101' });
    expect(second.operations).toHaveLength(1);
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(2);
  });

  it('reports an undecryptable sealed message as MISSING_E2EE_KEY instead of failing the batch', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    stream.write([receive(101, text(101, { chunks: ['AA==', 'AA==', 'AA==', 'AA=='], contentMetadata: { e2eeVersion: '2' } }))]);
    await flush();
    const result = await adapter.sync({ ...cursor0, revision: '100' });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } });
  });

  it('refreshes the token and replays the seed read when getLastOpRevision answers inner 119, without a receiver failure', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = new FakeSseStream();
    server.on(SSE, () => stream.response);
    server.on(tp('getLastOpRevision'),
      failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 119, reason: 'refresh' } }), ok(100));
    server.always(tp('getLastOpRevision'), () => ok(100));
    server.on('/api/auth/tokenRefresh', ok({ accessToken: 'tok-2', refreshToken: 'refresh-2', tokenIssueTimeEpochSec: '1700000000',
      durationUntilRefreshInSec: '3600' }));
    await adapter.sync(cursor0); // starts the stream and seeds
    await flush(30);
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
    const seeds = server.to(tp('getLastOpRevision'));
    expect(seeds).toHaveLength(2); // the refresh does not restart the seed (A28)
    expect(seeds[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok');
    expect(seeds.at(-1)!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok-2');
    expect(adapter.receiverState.kind).toBe('open');
    expect(server.to(SSE)).toHaveLength(1);
    expect(server.to(SSE)[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok-2');
  });

  it('keeps the one-refresh budget of the seed: a second 119 ends in backoff with one failure and no third seed', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const inner119 = () => failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 119, reason: 'refresh' } });
    server.on(tp('getLastOpRevision'), inner119(), inner119());
    server.on('/api/auth/tokenRefresh', ok({ accessToken: 'tok-2', refreshToken: 'refresh-2', tokenIssueTimeEpochSec: '1700000000',
      durationUntilRefreshInSec: '3600' }));
    await adapter.sync(cursor0);
    await flush(40);
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
    expect(server.to(tp('getLastOpRevision'))).toHaveLength(2);
    expect(adapter.receiverState).toMatchObject({ kind: 'backoff', failures: 1 });
    await flush(20);
    expect(server.to(tp('getLastOpRevision'))).toHaveLength(2); // no third seed before the backoff ends
  });

  it('delivers pending catch-up items before live operations: 20 pending + 80 live, then the remaining 40 live', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    const chatA = chatMid(30);
    const chatB = chatMid(31);
    server.always(tp('getRecentMessagesV2'), () => {
      const [chat] = JSON.parse(server.requests.at(-1)!.body!) as [string];
      return ok(Array.from({ length: chat === chatA ? 2 : 20 }, (_, index) => text(3000 - index, { to: chat })));
    });
    // 98 live messages and two read receipts fill the batch. Chat A returns 2 rows (they fit), chat B returns 20 (all wait).
    stream.write([...Array.from({ length: 98 }, (_, index) => receive(101 + index, text(101 + index))), readOp(199, chatA, '9'), readOp(200, chatB, '9')]);
    await flush();
    const first = await adapter.sync({ ...cursor0, revision: '100' });
    expect(first.operations).toHaveLength(100);
    expect(first.cursorAfter.revision).toBe('200');
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(2);

    stream.write(Array.from({ length: 120 }, (_, index) => receive(201 + index, text(201 + index))));
    await flush();
    const second = await adapter.sync({ ...cursor0, revision: '200' });
    expect(second.operations).toHaveLength(100);
    const sources = second.operations.map((operation) => (operation as { source?: string }).source);
    expect(sources.slice(0, 20).every((source) => source === 'history')).toBe(true);
    expect(sources.slice(20).some((source) => source === 'history')).toBe(false);
    expect(second.cursorAfter.revision).toBe('280'); // the 80th live revision
    const third = await adapter.sync({ ...cursor0, revision: '280' });
    expect(third.operations).toHaveLength(40);
    expect(third.cursorAfter.revision).toBe('320');
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(2);
  });

  it('seeds again for a new session: installSecrets resets the stream seed', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    await openStream(server, adapter, '0');
    expect(server.to(tp('getLastOpRevision'))).toHaveLength(1);
    server.on(SSE, () => new FakeSseStream().response);
    await adapter.installSecrets({ token: 'tok-new', qrCert: null, e2eeStorage: snapshot() });
    await adapter.sync(cursor0);
    await flush();
    expect(server.to(tp('getLastOpRevision'))).toHaveLength(2);
  });

  it('installSecrets keeps the pending catch-up items and the seen set', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    const chat = chatMid(40);
    server.always(tp('getRecentMessagesV2'), () => ok(Array.from({ length: 20 }, (_, index) => text(4000 - index, { to: chat }))));
    stream.write([...Array.from({ length: 99 }, (_, index) => receive(101 + index, text(101 + index))), readOp(200, chat, '9')]);
    await flush();
    const first = await adapter.sync({ ...cursor0, revision: '100' });
    expect(first.operations).toHaveLength(100); // 99 live + 1 catch-up item, 19 wait
    server.on(SSE, () => new FakeSseStream().response);
    await adapter.installSecrets({ token: 'tok-2', qrCert: null, e2eeStorage: snapshot() });
    const second = await adapter.sync({ ...cursor0, revision: '200' });
    await flush();
    const rest = second.operations.length > 0 ? second : await adapter.sync({ ...cursor0, revision: '200' });
    expect(rest.operations).toHaveLength(19);
    expect(server.to(tp('getRecentMessagesV2'))).toHaveLength(1);
  });

  it('rejects a DESKTOPWIN cursor and a sync without a session', async () => {
    const { adapter } = await build();
    await expect(adapter.sync({ ...cursor0, revision: '5' })).rejects.toThrow(/logged-in/);
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    await expect(adapter.sync({ version: 1, revision: '5', globalRev: '77', individualRev: '0' })).rejects.toBeInstanceOf(ChromeForeignCursorError);
    await expect(adapter.sync({ version: 1, revision: '5', globalRev: '0', individualRev: '3' })).rejects.toBeInstanceOf(ChromeForeignCursorError);
  });

  it('throws a classified error while the stream is disconnected and reopens it on request', async () => {
    const clock = instantBackoffClock();
    const { adapter, server } = await build({ receiveClock: clock });
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    server.always(tp('getLastOpRevision'), () => ok(100));
    // An HTTP 401 on the stream is an ordinary failed attempt: after 144 of them the receiver is disconnected.
    server.always(SSE, () => new Response('denied', { status: 401 }));
    await adapter.sync(cursor0); // starts the stream
    await flush(60);
    expect(adapter.receiverState).toMatchObject({ kind: 'disconnected', authRejected: false, failures: 144 });
    await expect(adapter.sync(cursor0)).rejects.toBeInstanceOf(ChromeReceiverDisconnectedError);
    await expect(adapter.sync(cursor0)).rejects.toMatchObject({ code: 'CHROME_SSE_DISCONNECTED', authRejected: false });
    expect(server.to(SSE)).toHaveLength(144); // nothing restarts it by itself
    clock.fast = false;

    const stream = new FakeSseStream();
    server.on(SSE, () => stream.response);
    expect(adapter.reconnectReceiver()).toBe(true);
    await adapter.sync({ ...cursor0, revision: '100' }).catch(() => undefined);
    await flush();
    expect(server.to(SSE)).toHaveLength(145);
    stream.write([receive(101, text(101))]);
    await flush();
    expect((await adapter.sync({ ...cursor0, revision: '100' })).operations).toHaveLength(1);
  });

  it('stops the stream on revoke and refuses further work', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    adapter.revoke();
    await flush();
    expect(stream.closed).toBe(true);
    expect(adapter.receiverState.kind).toBe('stopped');
    await expect(adapter.sync({ ...cursor0, revision: '100' })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(adapter.reconnectReceiver()).toBe(false);
  });

  it('reconnects the stream after a successful token refresh', async () => {
    const { adapter, server, timers, clock } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const stream = await openStream(server, adapter, '100');
    expect(server.to(SSE)).toHaveLength(1);
    clock.t = NOW + 3_600_000;
    server.on('/api/auth/tokenRefresh', ok({ accessToken: 'tok-2', refreshToken: 'refresh-2', tokenIssueTimeEpochSec: '1700000000',
      durationUntilRefreshInSec: '3600' }));
    server.on(SSE, () => new FakeSseStream().response);
    timers.scheduled.at(-1)!.callback();
    await flush(24);
    expect(stream.closed).toBe(true);
    expect(server.to(SSE)).toHaveLength(2);
    expect(server.to(SSE)[1]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok-2');
    expect(server.to('/api/auth/tokenRefresh')[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok');
  });
});

// -- history --------------------------------------------------------------------------------------------------------

describe('ChromeAdapter.history', () => {
  const convo = { chatType: 'group' as const, chatId: GROUP };
  it('reads the newest page, then continues with getPreviousMessagesV2WithRequest [..., 3]', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const rows = [text(30), text(29)];
    server.on(tp('getRecentMessagesV2'), ok(rows));
    expect(await adapter.history(convo, null, 2)).toEqual(rows);
    expect(server.bodies(tp('getRecentMessagesV2'))).toEqual([[GROUP, 2]]);

    const cursor = { version: 1 as const, accountId: 'account-A', chatType: 'group' as const, chatId: GROUP, messageId: '29', deliveredTime: '1700000000029' };
    server.on(tp('getPreviousMessagesV2WithRequest'), ok([text(28)]));
    expect(await adapter.history(convo, cursor, 1)).toEqual([text(28)]);
    expect(server.bodies(tp('getPreviousMessagesV2WithRequest'))).toEqual([[
      { messageBoxId: GROUP, endMessageId: { messageId: '29', deliveredTime: 1_700_000_000_029 }, messagesCount: 1 }, 3]]);
  });
  it('rejects a cursor of another conversation and a malformed response', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    const cursor = { version: 1, accountId: 'account-A', chatType: 'group', chatId: chatMid(77), messageId: '1', deliveredTime: '2' } as const;
    await expect(adapter.history(convo, cursor, 1)).rejects.toBeInstanceOf(EffectDeniedError);
    server.on(tp('getRecentMessagesV2'), ok({ not: 'a list' }));
    await expect(adapter.history(convo, null, 1)).rejects.toThrow(/invalid/);
  });
  it('fails the whole page when a sealed message cannot be decrypted, like the DESKTOPWIN history', async () => {
    const { adapter, server } = await build();
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    server.on(tp('getRecentMessagesV2'), ok([text(5, { contentMetadata: { e2eeVersion: '2' }, chunks: ['AA==', 'AA==', 'AA=='] })]));
    await expect(adapter.history(convo, null, 1)).rejects.toThrow();
  });
});

// -- through the real worker loop -----------------------------------------------------------------------------------

describe('ChromeAdapter through LineWorkerLoop', () => {
  async function start(options: { mode?: 'MONITOR_ONLY' | 'ACTIVE_CONTROL'; receiveClock?: ReceiveClock } = {}) {
    const harness = await build(options);
    quietCatalog(harness.server);
    harness.server.always(tp('getProfile'), () => ok(PROFILE));
    const events: LineWorkerEvent[] = [];
    const worker = new LineWorkerLoop({ transport: harness.adapter, emit: (event) => { events.push(LineWorkerEventSchema.parse(event)); },
      validateLease: () => true });
    await worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: options.mode ?? 'MONITOR_ONLY', durableCursor: cursor0, lineTransport: 'CHROMEOS' });
    await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
      secrets: { token: 'tok', qrCert: null, e2eeStorage: snapshot() } });
    await worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
    await flush();
    return { ...harness, worker, events };
  }
  const batches = (events: LineWorkerEvent[]) => events.filter((event): event is Extract<LineWorkerEvent, { type: 'batch' }> => event.type === 'batch');

  it('logs in, publishes the catalog, then drains and acknowledges through poll/ack', async () => {
    const { worker, events, server } = await start();
    expect(events.find((event) => event.type === 'login')).toMatchObject({ ownMid: SELF, displayName: 'Agent' });
    expect(events.some((event) => event.type === 'conversationCatalog')).toBe(true);

    const stream = new FakeSseStream();
    server.on(SSE, () => stream.response);
    server.always(tp('getLastOpRevision'), () => ok(100));
    await worker.handle({ type: 'poll', ...binding });
    await flush();
    expect(batches(events)).toHaveLength(0);
    stream.write([receive(101, text(101, { to: SELF, toType: 0 })), receive(102, text(102))]);
    await flush();

    await worker.handle({ type: 'poll', ...binding });
    const [batch] = batches(events);
    expect(batch!.cursorBefore).toEqual(cursor0);
    expect(batch!.cursorAfter).toEqual({ version: 1, revision: '102', globalRev: '0', individualRev: '0' });
    expect(batch!.envelopes.map((envelope) => envelope.messageId)).toEqual(['101', '102']);
    expect(batch!.envelopes[0]).toMatchObject({ chatType: 'direct', chatId: PEER, text: 'm101' });
    expect(batch!.envelopes[1]).toMatchObject({ chatType: 'group', chatId: GROUP, text: 'm102' });

    await worker.handle({ type: 'ackBatch', ...binding, batchId: batch!.batchId, cursorAfter: batch!.cursorAfter });
    await worker.handle({ type: 'poll', ...binding });
    expect(batches(events)).toHaveLength(1);
    expect(worker.durableCursor).toEqual(batch!.cursorAfter);
  });

  it('re-emits an unacknowledged batch instead of draining twice', async () => {
    const { worker, events, server } = await start();
    const stream = new FakeSseStream();
    server.on(SSE, () => stream.response);
    server.always(tp('getLastOpRevision'), () => ok(100));
    await worker.handle({ type: 'poll', ...binding });
    await flush();
    stream.write([receive(101, text(101))]);
    await flush();
    await worker.handle({ type: 'poll', ...binding });
    await worker.handle({ type: 'poll', ...binding });
    const emitted = batches(events);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.batchId).toBe(emitted[0]!.batchId);
  });

  it('degrades after five failed polls on a disconnected stream and recovers after a reconnect', async () => {
    const clock = instantBackoffClock();
    const { worker, events, server, adapter } = await start({ receiveClock: clock });
    server.always(tp('getLastOpRevision'), () => ok(100));
    server.always(SSE, () => new Response('denied', { status: 401 }));
    await worker.handle({ type: 'poll', ...binding });
    await flush(60);
    for (let i = 0; i < 5; i += 1) await worker.handle({ type: 'poll', ...binding });
    expect(events.filter((event) => event.type === 'status' && event.state === 'degraded')).toHaveLength(1);
    clock.fast = false;

    const stream = new FakeSseStream();
    server.on(SSE, () => stream.response);
    adapter.reconnectReceiver();
    await worker.handle({ type: 'poll', ...binding });
    await flush();
    stream.write([receive(101, text(101))]);
    await flush();
    await worker.handle({ type: 'poll', ...binding });
    // The reopened stream seeds at the server revision (100): the first batch is that jump, which is re-emitted until acked.
    expect(batches(events).length).toBeGreaterThanOrEqual(1);
    expect(batches(events)[0]!.cursorAfter.revision).toBe('100');
    expect(events.filter((event) => event.type === 'status' && event.state === 'ready').length).toBeGreaterThanOrEqual(2);
  });

  const sendResults = (events: LineWorkerEvent[]) => events.filter((event): event is Extract<LineWorkerEvent, { type: 'sendResult' }> => event.type === 'sendResult');

  it('runs a send through the real loop: sent with the message id, one sendMessage with reqSeq 1', async () => {
    const { worker, events, server } = await start({ mode: 'ACTIVE_CONTROL' });
    server.on(tp('sendMessage'), ok({ id: '4242', to: GROUP }));
    await worker.handle({ type: 'sendText', ...binding, chatType: 'group', chatId: GROUP, requestId: 'send-1', text: 'hi there', replyToMessageId: '17' });
    expect(sendResults(events)).toMatchObject([{ requestId: 'send-1', status: 'sent', messageId: '4242', error: null }]);
    expect(server.bodies(tp('sendMessage'))).toEqual([[1, { to: GROUP, toType: 2, contentMetadata: {}, sessionId: 0, text: 'hi there',
      contentType: 0, hasContent: false, relatedMessageId: '17', messageRelationType: 3, relatedMessageServiceCode: 1 }]]);
  });

  it('reports a network failure on the write as unknown, a server rejection as failed, and never retries', async () => {
    const { worker, events, server } = await start({ mode: 'ACTIVE_CONTROL' });
    server.on(tp('sendMessage'), new TypeError('socket closed'), failure(400, { code: 10051, message: 'RESPONSE_ERROR',
      data: { name: 'TalkException', code: 36, reason: 'x' } }));
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: PEER, requestId: 'send-net', text: 'a', replyToMessageId: null });
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: PEER, requestId: 'send-rej', text: 'b', replyToMessageId: null });
    expect(sendResults(events)).toMatchObject([
      { requestId: 'send-net', status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' },
      { requestId: 'send-rej', status: 'failed', error: 'LINE_TALK_NOT_FRIEND' },
    ]);
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
  });

  it('denies a send in monitor mode through the loop without a request', async () => {
    const { worker, events, server } = await start();
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: PEER, requestId: 'send-denied', text: 'a', replyToMessageId: null });
    expect(sendResults(events)).toMatchObject([{ requestId: 'send-denied', status: 'failed', error: 'SIDE_EFFECT_DENIED' }]);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  it('serves history commands through the loop', async () => {
    const { worker, events, server } = await start();
    server.on(tp('getRecentMessagesV2'), ok([text(30), text(29)]));
    await worker.handle({ type: 'history', ...binding, chatType: 'group', chatId: GROUP, requestId: 'h1', cursor: null, limit: 2 });
    const result = events.find((event) => event.type === 'historyResult');
    expect(result).toMatchObject({ requestId: 'h1', envelopes: [{ messageId: '30' }, { messageId: '29' }] });
    expect(result && 'nextCursor' in result && result.nextCursor).not.toBeNull();
  });
});
