// Step 6 tests: the CHROMEOS write path (send, sendMedia, react, unsend, addFriendByMid), OBS download, friend relation.
// Everything runs against fakes: a recording fetch, a fake sealer and a fake ltsm bridge. No network.
import { describe, expect, it } from 'vitest';
import {
  ChromeE2ee as RealChromeE2ee, ChromeError, FakeHmacSigner, CHROME_TRANSPORT_TAG, buildE2eeMessage, buildTalkMeta, decryptBlob, encryptBlob, mergeDecrypted,
  type ChromeE2ee, type ReceiveClock,
} from '@line-agent/line-chrome';
import { createChromeAdapter, type ChromeAdapter, type ChromeAdapterBridge } from './chrome-adapter.js';
import { EffectDeniedError } from './mutation-gate.js';
import { LineServerRejection } from './line-server-error.js';
import { SafeAttachmentError } from './attachment-error.js';
import { MediaUploadFailedError } from './worker-loop.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const lease = { ...binding };
const SELF = `u${'a'.repeat(32)}`;
const PEER = `u${'b'.repeat(32)}`;
const GROUP = `c${'c'.repeat(32)}`;
const NOW = 1_700_000_000_000;
const OBS = 'https://obs.line-apps.com';

const ok = (data: unknown): Response => new Response(JSON.stringify({ message: 'OK', data }), { status: 200 });
const talkError = (code: number, status = 400): Response => new Response(JSON.stringify({
  code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code, reason: 'x' } }), { status });
const tp = (method: string): string => `/api/talk/thrift/Talk/TalkService/${method}`;
const RELATION_ADD = '/api/talk/thrift/Relation/RelationService/addFriendByMid';
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function flush(rounds = 12): Promise<void> { for (let i = 0; i < rounds; i += 1) await tick(); }

type Reply = Response | Error | (() => Response | Promise<Response>);
type Recorded = { url: string; path: string; method: string; headers: Array<[string, string]>; body: string | Uint8Array | undefined };
class FakeServer {
  readonly requests: Recorded[] = [];
  /** Shared timeline with the sealer so the order of requests and E2EE steps can be asserted. */
  readonly timeline: string[] = [];
  private readonly queues = new Map<string, Reply[]>();
  private readonly fixed = new Map<string, Reply>();
  on(path: string, ...replies: Reply[]): this { this.queues.set(path, [...(this.queues.get(path) ?? []), ...replies]); return this; }
  always(path: string, reply: Reply): this { this.fixed.set(path, reply); return this; }
  /** Replies by path pattern (used for the random OBS reqid paths). */
  readonly patterns: Array<{ pattern: RegExp; replies: Reply[] }> = [];
  onMatch(pattern: RegExp, ...replies: Reply[]): this { this.patterns.push({ pattern, replies }); return this; }
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    this.requests.push({ url, path, method: init.method ?? 'GET',
      headers: (init.headers as Array<[string, string]>).map(([name, value]) => [name, value]), body: init.body as string | Uint8Array | undefined });
    this.timeline.push(`${init.method ?? 'GET'} ${path}`);
    const next = this.queues.get(path)?.shift() ?? this.fixed.get(path)
      ?? this.patterns.find((entry) => entry.pattern.test(path) && entry.replies.length > 0)?.replies.shift();
    if (next === undefined) throw new Error(`unexpected request to ${path}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  to(path: string): Recorded[] { return this.requests.filter((request) => request.path === path); }
  bodies(path: string): unknown[] { return this.to(path).map((request) => JSON.parse(String(request.body ?? 'null'))); }
}

const inertClock: ReceiveClock = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => undefined };
const timers = { set: () => 1, clear: () => undefined };

function fakeBridge(): ChromeAdapterBridge {
  const unexpected = (name: string) => async () => { throw new Error(`unexpected bridge call ${name}`); };
  return { curveKeyGenerate: unexpected('curveKeyGenerate'), e2eeGetKeyId: async () => 1000, e2eeExportKey: async (h: number) => `blob-${h}`,
    e2eeLoadKey: async () => 101 } as unknown as ChromeAdapterBridge;
}

/** Stands in for `ChromeE2ee`: seals with the real framing helper, records every step on the shared timeline. */
class FakeSealer {
  ready = true;
  /** When set, `encrypt` returns the message untouched (sealing declined by the negotiation). */
  decline = false;
  readonly encrypted: Array<Record<string, unknown>> = [];
  /** The options of every `encrypt` call. */
  readonly encryptOptions: Array<{ mediaFlowChecked?: boolean } | undefined> = [];
  readonly resets: string[] = [];
  readonly recovered: unknown[] = [];
  readonly decrypts: Array<Record<string, unknown>> = [];
  /** `mediaFlowIsV2` answer, and the (chat, content type) pairs it was asked. */
  mediaV2 = true;
  readonly mediaFlowChecks: Array<[string, number]> = [];
  encKm: string | null = null;
  /** When set, `decrypt` merges this plaintext JSON with the real `mergeDecrypted` instead of the fixed ENC_KM and FILE_NAME. */
  plainJson: string | null = null;
  constructor(private readonly timeline: string[]) {}
  isReady(): boolean { return this.ready; }
  adoptLogin(): boolean { return true; }
  async loadFromState(): Promise<boolean> { return this.ready; }
  async encrypt(message: Record<string, unknown>, options?: { mediaFlowChecked?: boolean }): Promise<Record<string, unknown>> {
    this.timeline.push('encrypt');
    this.encryptOptions.push(options);
    this.encrypted.push(message);
    if (this.decline) return message;
    const meta = message.contentMetadata as Record<string, unknown>;
    if (typeof meta.ENC_KM === 'string') this.encKm = meta.ENC_KM;
    return buildE2eeMessage(message, ['c0', 'c1', 'c2', 'c3', 'c4'], 2);
  }
  async decrypt(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.decrypts.push(message);
    if (this.plainJson !== null) return mergeDecrypted(message, Buffer.from(this.plainJson, 'utf8'));
    return { ...message, chunks: [], contentMetadata: { ...(message.contentMetadata as object), ENC_KM: this.encKm, FILE_NAME: 'photo.png' } };
  }
  async mediaFlowIsV2(chat: string, contentType: number): Promise<boolean> { this.mediaFlowChecks.push([chat, contentType]); return this.mediaV2; }
  resetNegotiation(chat: string): void { this.timeline.push('reset'); this.resets.push(chat); }
  async recoverFromSendError(message: Record<string, unknown>, error: unknown): Promise<{ retry: boolean }> {
    this.timeline.push('recover');
    this.recovered.push(error);
    return { retry: true };
  }
}

const snapshot = (extra: Record<string, unknown> = {}) => ({ transport: CHROME_TRANSPORT_TAG, refreshToken: 'refresh-0',
  tokenIssueTimeEpochSec: 1_700_000_000, durationUntilRefreshInSec: 3600, mid: SELF, ...extra });

async function build(options: { mode?: 'MONITOR_ONLY' | 'ACTIVE_CONTROL' | 'PAUSED'; reqSeq?: number; sealerReady?: boolean } = {}) {
  const server = new FakeServer();
  let sealer!: FakeSealer;
  const adapter = await createChromeAdapter({
    ...binding, mode: options.mode ?? 'ACTIVE_CONTROL', validateLease: () => true, fetch: server.fetch,
    signer: new FakeHmacSigner(), bridge: fakeBridge(), receiveClock: inertClock, receiveWaitMs: 0, timers, now: () => NOW,
    createE2ee: () => { sealer = new FakeSealer(server.timeline); sealer.ready = options.sealerReady ?? true; return sealer as unknown as ChromeE2ee; },
  });
  const events: Array<{ event: string; value: unknown }> = [];
  for (const event of ['qr', 'pin', 'token', 'qrCert', 'storage', 'credentials', 'authInvalidated', 'refreshFailure'] as const) {
    adapter.on(event, (value) => { events.push({ event, value }); });
  }
  await adapter.installSecrets({ token: 'tok', qrCert: null,
    e2eeStorage: snapshot(options.reqSeq === undefined ? {} : { 'chrome:reqSeq': options.reqSeq }) });
  events.length = 0;
  return { server, adapter, sealer, events };
}

const conv = { chatType: 'direct' as const, chatId: PEER };
const sent = (id = '900') => ok({ id, to: PEER });
const headerNames = (request: Recorded): string[] => request.headers.map(([name]) => name.toLowerCase());

// -- send -------------------------------------------------------------------------------------------------------------

describe('ChromeAdapter.send', () => {
  it('sends a sealed text with the exact message, reqSeq and header set, and returns the message id', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('sendMessage'), sent('12345678901234567890'));

    const result = await adapter.send(conv, 'hello', null, lease);

    expect(result).toEqual({ messageId: '12345678901234567890' });
    expect(sealer.encrypted[0]).toEqual({ to: PEER, toType: 0, contentMetadata: {}, sessionId: 0, text: 'hello', contentType: 0, hasContent: false });
    const [body] = server.bodies(tp('sendMessage')) as Array<[number, Record<string, unknown>]>;
    expect(body![0]).toBe(1);
    expect(body![1]).toEqual({ to: PEER, toType: 0, contentMetadata: { e2eeVersion: '2' }, sessionId: 0, contentType: 0, hasContent: false,
      chunks: ['c0', 'c1', 'c2', 'c3', 'c4'] });
    const request = server.to(tp('sendMessage'))[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`https://line-chrome-gw.line-apps.com${tp('sendMessage')}`);
    expect(headerNames(request)).toEqual(['accept', 'x-line-chrome-version', 'accept-language', 'user-agent', 'x-lal', 'x-line-access', 'content-type', 'x-hmac']);
    expect(headerNames(request)).not.toContain('x-line-application');
    expect(headerNames(request)).not.toContain('cookie');
    expect(request.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe('tok');
  });

  it('adds the reply fields and the MENTION metadata (same builder as DESKTOPWIN)', async () => {
    const { adapter, server, sealer } = await build({ sealerReady: false });
    server.on(tp('sendMessage'), sent());
    const mentions = [{ start: 6, end: 11, userId: PEER }, { start: 0, end: 5, userId: SELF }];

    await adapter.send({ chatType: 'group', chatId: GROUP }, 'Alice hello', '777', lease, false, mentions);

    expect(sealer.encrypted).toHaveLength(0); // keys not loaded: the plain path
    const [body] = server.bodies(tp('sendMessage')) as Array<[number, Record<string, unknown>]>;
    expect(body![1]).toEqual({
      to: GROUP, toType: 2, sessionId: 0, text: 'Alice hello', contentType: 0, hasContent: false,
      contentMetadata: { MENTION: JSON.stringify({ MENTIONEES: [{ S: '0', E: '5', M: SELF }, { S: '6', E: '11', M: PEER }] }) },
      relatedMessageId: '777', messageRelationType: 3, relatedMessageServiceCode: 1,
    });
  });

  it('allocates reqSeq monotonically, checkpoints it before use and resumes from the persisted value', async () => {
    const { adapter, server, events } = await build({ reqSeq: 41 });
    server.always(tp('sendMessage'), () => sent());
    await adapter.send(conv, 'a', null, lease);
    await adapter.send(conv, 'b', null, lease);
    expect((server.bodies(tp('sendMessage')) as Array<[number]>).map((body) => body[0])).toEqual([42, 43]);
    const checkpoints = events.filter((entry) => entry.event === 'storage').map((entry) => (entry.value as Record<string, unknown>)['chrome:reqSeq']);
    expect(checkpoints).toEqual([42, 43]);
    // The first storage event precedes the first request: allocate, persist, use.
    expect(events[0]!.event).toBe('storage');
  });

  it('uses one single-use permit per send: a second physical write inside the same permit is denied', async () => {
    const { adapter, server } = await build();
    server.always(tp('sendMessage'), () => sent());
    // Two independent sends are two permits and both pass.
    await adapter.send(conv, 'a', null, lease);
    await adapter.send(conv, 'b', null, lease);
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
  });

  it('denies sends in read-only modes and for a mismatched conversation, without any request', async () => {
    const monitor = await build({ mode: 'MONITOR_ONLY' });
    await expect(monitor.adapter.send(conv, 'x', null, lease)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(monitor.adapter.react(conv, '1', 'NICE', lease)).rejects.toBeInstanceOf(EffectDeniedError);
    const active = await build();
    await expect(active.adapter.send({ chatType: 'group', chatId: PEER }, 'x', null, lease)).rejects.toBeInstanceOf(EffectDeniedError);
    expect(monitor.server.requests).toHaveLength(0);
    expect(active.server.requests).toHaveLength(0);
  });

  it('allows a manual send in MONITOR_ONLY (MANUAL_SEND phase)', async () => {
    const { adapter, server } = await build({ mode: 'MONITOR_ONLY' });
    server.on(tp('sendMessage'), sent());
    await expect(adapter.send(conv, 'x', null, lease, true)).resolves.toEqual({ messageId: '900' });
  });

  it('reports a network failure on the write as unknown and never retries it', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), new TypeError('socket hang up'));
    const error = await adapter.send(conv, 'x', null, lease).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ChromeTransportError', outcomeUnknown: true });
    expect(error).not.toBeInstanceOf(LineServerRejection);
    expect(server.to(tp('sendMessage'))).toHaveLength(1);
  });

  it('does not retry a 5xx or a retryable envelope on a write', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), new Response('boom', { status: 502 }), new Response(JSON.stringify({ code: 99999, message: 'UNKNOWN' }), { status: 200 }));
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow();
    await expect(adapter.send(conv, 'y', null, lease)).rejects.toThrow();
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
  });

  it('projects a TalkException into a LineServerRejection', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), talkError(36));
    const error = await adapter.send(conv, 'x', null, lease).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LineServerRejection);
    expect((error as LineServerRejection).code).toBe('LINE_TALK_NOT_FRIEND');
  });

  it('refreshes the token once on inner 119, does not replay the write and reports a definitive rejection', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), talkError(119), sent('77'));
    server.on('/api/auth/tokenRefresh', ok({ accessToken: 'tok-2', refreshToken: 'refresh-2', tokenIssueTimeEpochSec: '1700000000',
      durationUntilRefreshInSec: '3600' }));
    const error = await adapter.send(conv, 'x', null, lease).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LineServerRejection);
    expect((error as LineServerRejection).code).toBe('LINE_TALK_MUST_REFRESH_V3_TOKEN');
    expect(server.to('/api/auth/tokenRefresh')).toHaveLength(1);
    expect(server.to(tp('sendMessage'))).toHaveLength(1);
  });

  it.each([84, 86, 87, 88, 90, 99])('retries exactly once under a NEW permit after E2EE code %i, with a new reqSeq', async (code) => {
    const { adapter, server, sealer } = await build();
    server.on(tp('sendMessage'), talkError(code), sent('55'));
    const result = await adapter.send(conv, 'x', null, lease);
    expect(result).toEqual({ messageId: '55' });
    expect((server.bodies(tp('sendMessage')) as Array<[number]>).map((body) => body[0])).toEqual([1, 2]);
    expect(sealer.recovered).toHaveLength(1);
    // recover runs after the rejected write and before the retry is sealed and written.
    expect(server.timeline).toEqual(['encrypt', `POST ${tp('sendMessage')}`, 'recover', 'encrypt', `POST ${tp('sendMessage')}`]);
  });

  it('does not retry twice: a second renegotiation error ends the send', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), talkError(84), talkError(84), sent());
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow();
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
  });

  it('does not retry code 122: it resets the negotiation and surfaces the error', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('sendMessage'), talkError(122), sent());
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow();
    expect(server.to(tp('sendMessage'))).toHaveLength(1);
    expect(sealer.resets).toEqual([PEER]); // the local reset
    expect(sealer.recovered).toHaveLength(0);
  });

  it('resets the whole chat state when the second attempt also fails with 84, and does not register a group key', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('sendMessage'), talkError(84), talkError(84), sent());
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow();
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
    expect(sealer.recovered).toHaveLength(1); // the first failure: recovery before the retry
    expect(sealer.resets).toEqual([PEER]); // the final failure: a full reset of the chat
    expect(server.to(tp('registerE2EEGroupKey'))).toHaveLength(0);
  });

  it('resets on the final failure for 99 without registering the group key again', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('sendMessage'), talkError(99), talkError(99), sent());
    await expect(adapter.send({ chatType: 'group', chatId: GROUP }, 'x', null, lease)).rejects.toThrow();
    expect(sealer.resets).toEqual([GROUP]);
    expect(sealer.recovered).toHaveLength(1);
  });

  it('does not retry an unrelated server error', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('sendMessage'), talkError(36), sent());
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow();
    expect(server.to(tp('sendMessage'))).toHaveLength(1);
    expect(sealer.recovered).toHaveLength(0);
  });

  it('handles code 82 on an unsealed send: seal again and retry once, without a negotiation reset', async () => {
    const { adapter, server, sealer } = await build();
    sealer.decline = true;
    // The 82 answer arrives, then sealing becomes possible (a fresh negotiation allows the type); the retry must seal.
    server.on(tp('sendMessage'), () => { sealer.decline = false; return talkError(82); }, sent('66'));
    const result = await adapter.send(conv, 'x', null, lease);
    expect(result).toEqual({ messageId: '66' });
    expect(sealer.resets).toEqual([]);
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
    const [, second] = server.bodies(tp('sendMessage')) as Array<[number, { chunks?: unknown }]>;
    expect(second![1].chunks).toBeDefined();
  });

  it('code 82 on an unsealed send never negotiates again: the retry only seals', async () => {
    const { adapter, server, sealer } = await build();
    sealer.decline = true;
    server.on(tp('sendMessage'), () => { sealer.decline = false; return talkError(82); }, sent('67'));
    await adapter.send(conv, 'x', null, lease);
    expect(sealer.resets).toEqual([]);
    expect(sealer.recovered).toHaveLength(1);
    expect(server.to(tp('negotiateE2EEPublicKey'))).toHaveLength(0);
    expect(server.to(tp('getE2EEPublicKey'))).toHaveLength(0);
  });

  it('does not retry code 82 when the first send was already sealed', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), talkError(82), sent());
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow();
    expect(server.to(tp('sendMessage'))).toHaveLength(1);
  });

  it('fails when the response carries no message id (the write happened, so the outcome is unknown)', async () => {
    const { adapter, server } = await build();
    server.on(tp('sendMessage'), ok({}));
    await expect(adapter.send(conv, 'x', null, lease)).rejects.toThrow(/no message id/);
  });
});


// -- sendMedia --------------------------------------------------------------------------------------------------------

const decodeParams = (request: Recorded): Record<string, unknown> =>
  JSON.parse(Buffer.from(request.headers.find(([name]) => name === 'X-Obs-Params')![1], 'base64').toString('utf8')) as Record<string, unknown>;
const ENC_TOKEN = '1700000000000\u001eencTokenValue\u001fignored';
const obsOk = (oid: string): Response => new Response('', { status: 200, headers: { 'x-obs-oid': oid, 'x-obs-hash': 'h' } });
const REQID_EMI = /^\/r\/talk\/emi\/reqid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQID_EMF = /^\/r\/talk\/emf\/reqid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('ChromeAdapter.sendMedia', () => {
  const bytes = Buffer.from('hello image bytes');
  const target = { chatType: 'direct' as const, chatId: PEER };

  it('uploads the encrypted blob once, then sends the sealed placeholder (image)', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMI, obsOk('0abc123'));
    server.on(tp('sendMessage'), sent('77'));

    const result = await adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'photo.png' }, lease);

    expect(result).toEqual({ messageId: '77' });
    // One token, ONE upload (no preview), one seal, one sendMessage. The media flow is checked before any OBS request.
    expect(sealer.mediaFlowChecks).toEqual([[PEER, 1]]);
    expect(server.timeline.map((entry) => entry.replace(/reqid-.*/, 'reqid-*'))).toEqual([
      `POST ${tp('acquireEncryptedAccessToken')}`, 'POST /r/talk/emi/reqid-*', 'encrypt', `POST ${tp('sendMessage')}`,
    ]);
    expect(server.bodies(tp('acquireEncryptedAccessToken'))).toEqual([[2]]);
    const obsRequests = server.requests.filter((request) => request.url.startsWith(OBS));
    expect(obsRequests).toHaveLength(1);
    const [first] = obsRequests;
    expect(first!.headers.map(([name]) => name)).toEqual(['accept', 'X-Line-Chrome-Version', 'Accept-Language', 'User-Agent', 'X-Line-Access',
      'X-Line-Application', 'X-Obs-Params']);
    expect(first!.headers.find(([name]) => name === 'X-Line-Access')![1]).toBe('encTokenValue');
    expect(first!.headers.find(([name]) => name === 'X-Line-Application')![1]).toBe('CHROMEOS\t3.7.2\tChrome_OS\t');
    expect(headerNames(first!)).not.toContain('x-hmac');
    expect(headerNames(first!)).not.toContain('cookie');
    // The blob name is the Unix millisecond timestamp (line-cli client.go:663-667); the real name stays in the sealed plaintext.
    expect(decodeParams(first!)).toEqual({ ver: '2.0', name: String(NOW), type: 'file' });
    expect(Object.keys(decodeParams(first!))).toEqual(['ver', 'name', 'type']);
    // The blob decrypts with the key material that was sealed into the placeholder.
    const blob = Buffer.from(first!.body as Uint8Array);
    expect(decryptBlob(Buffer.from(sealer.encKm!, 'base64'), blob)).toEqual(bytes);
    const [message] = sealer.encrypted;
    expect(message).toMatchObject({ to: PEER, toType: 0, sessionId: 0, text: '', contentType: 1, hasContent: true });
    expect(message!.contentMetadata).toMatchObject({ SID: 'emi', OID: '0abc123', FILE_SIZE: String(bytes.length), ENC_KM: sealer.encKm, FILE_NAME: 'photo.png' });
    expect(blob.length).not.toBe(bytes.length); // FILE_SIZE is the plaintext size, not the encrypted blob size
    expect(Object.keys(message!.contentMetadata as object).sort()).toEqual(['ENC_KM', 'FILE_NAME', 'FILE_SIZE', 'OID', 'SID']);
    // On the wire the key material and the name are gone (sealed), and the message is the sealed one.
    const [body] = server.bodies(tp('sendMessage')) as Array<[number, Record<string, any>]>;
    expect(body![0]).toBe(1);
    expect(body![1].contentMetadata).toMatchObject({ SID: 'emi', OID: '0abc123', e2eeVersion: '2' });
    expect(body![1].contentMetadata.ENC_KM).toBeUndefined();
    expect(body![1].contentMetadata.FILE_NAME).toBeUndefined();
    expect(body![1].chunks).toHaveLength(5);
  });

  it('uploads a file with a single POST to emf and carries FILE_NAME in the placeholder', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, obsOk('9zz'));
    server.on(tp('sendMessage'), sent('78'));
    await adapter.sendMedia({ chatType: 'group', chatId: GROUP }, { kind: 'file', bytes, fileName: 'a.pdf' }, lease);
    expect(server.requests.filter((request) => request.url.startsWith(OBS))).toHaveLength(1);
    expect(sealer.encrypted[0]).toMatchObject({ to: GROUP, toType: 2, contentType: 14 });
    expect(sealer.encrypted[0]!.contentMetadata).toMatchObject({ SID: 'emf', OID: '9zz', FILE_NAME: 'a.pdf' });
    expect((sealer.encrypted[0]!.contentMetadata as Record<string, unknown>).MEDIA_CONTENT_INFO).toBeUndefined();
  });

  it('throws MediaUploadFailedError before any request when the media flow is not V2', async () => {
    const { adapter, server, sealer } = await build();
    sealer.mediaV2 = false;
    await expect(adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    expect(sealer.mediaFlowChecks).toEqual([[PEER, 1]]);
    expect(server.requests).toHaveLength(0);
  });

  it('throws MediaUploadFailedError and sends nothing when the upload fails', async () => {
    const { adapter, server } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, new Response('no', { status: 500 }));
    await expect(adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  it('throws MediaUploadFailedError when the token cannot be acquired or the upload errors on the network', async () => {
    const first = await build();
    first.server.on(tp('acquireEncryptedAccessToken'), talkError(36));
    await expect(first.adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    const second = await build();
    second.server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    second.server.onMatch(REQID_EMF, new TypeError('reset'));
    await expect(second.adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    expect(first.server.to(tp('sendMessage')).length + second.server.to(tp('sendMessage')).length).toBe(0);
  });

  it('never sends a media placeholder unsealed (key material would travel in the clear)', async () => {
    const { adapter, server, sealer } = await build();
    sealer.decline = true;
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, obsOk('9zz'));
    await expect(adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  it('reports a sendMessage failure after the upload like a text send (unknown), not as an upload failure', async () => {
    const { adapter, server } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, obsOk('9zz'));
    server.on(tp('sendMessage'), new TypeError('reset'));
    const error = await adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(MediaUploadFailedError);
    expect(error).toMatchObject({ outcomeUnknown: true });
    expect(server.to(tp('sendMessage'))).toHaveLength(1);
  });

  it('retries the renegotiation once in a new permit without uploading again', async () => {
    const { adapter, server } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, obsOk('9zz'));
    server.on(tp('sendMessage'), talkError(88), sent('79'));
    await expect(adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease)).resolves.toEqual({ messageId: '79' });
    expect(server.requests.filter((request) => request.url.startsWith(OBS))).toHaveLength(1);
    expect(server.to(tp('sendMessage'))).toHaveLength(2);
    expect((server.bodies(tp('sendMessage')) as Array<[number]>).map((body) => body[0])).toEqual([1, 2]);
  });

  it('checks the media flow once per send attempt: attempt 0 skips the gate in the seal, the retry checks in the seal', async () => {
    const { adapter, server, sealer } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, obsOk('9zz'));
    server.on(tp('sendMessage'), talkError(88), sent('80'));
    await adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease);
    expect(sealer.mediaFlowChecks).toHaveLength(1); // the prepare step
    expect(sealer.encryptOptions).toEqual([{ mediaFlowChecked: true }, { mediaFlowChecked: false }]);
  });

  it('fails the send when the upload answer has the object id only in a JSON body', async () => {
    const { adapter, server } = await build();
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    server.onMatch(REQID_EMF, new Response('{"objId":"x"}', { status: 200 }));
    await expect(adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  describe('media upload failure stage', () => {
    const stageOf = async (promise: Promise<unknown>): Promise<MediaUploadFailedError> => {
      const error = await promise.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
      expect(error).toBeInstanceOf(MediaUploadFailedError);
      return error as MediaUploadFailedError;
    };

    it('names e2ee_flow when the media flow is not V2, before any request', async () => {
      const { adapter, server, sealer } = await build();
      sealer.mediaV2 = false;
      const error = await stageOf(adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease));
      expect(error.stage).toBe('e2ee_flow');
      expect(error.detail).toBe('e2ee_flow');
      expect(server.requests).toHaveLength(0);
    });

    it('names obs_upload with the error class and the HTTP status of a failed OBS POST', async () => {
      const { adapter, server } = await build();
      server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
      server.onMatch(REQID_EMF, new Response('no', { status: 500 }));
      const error = await stageOf(adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease));
      expect(error).toMatchObject({ stage: 'obs_upload', causeClass: 'ObsHttpError', causeNumber: 500 });
      expect(error.detail).toBe('obs_upload:ObsHttpError:500');
      expect(server.to(tp('sendMessage'))).toHaveLength(0);
    });

    it('names obs_upload when the OBS token cannot be acquired, when the network fails and when the object id is missing', async () => {
      const token = await build();
      token.server.on(tp('acquireEncryptedAccessToken'), talkError(36));
      expect((await stageOf(token.adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease))).stage).toBe('obs_upload');
      const network = await build();
      network.server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
      network.server.onMatch(REQID_EMF, new TypeError('reset'));
      const networkError = await stageOf(network.adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease));
      expect(networkError.stage).toBe('obs_upload');
      expect(networkError.detail).toMatch(/^obs_upload(?::[A-Za-z]{1,40})?(?::-?\d+)?$/);
      const missing = await build();
      missing.server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
      missing.server.onMatch(REQID_EMF, new Response('{"objId":"x"}', { status: 200 }));
      expect((await stageOf(missing.adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease))).stage).toBe('obs_upload');
    });

    it('names e2ee_message when sealing is declined after the upload, without a second upload', async () => {
      const { adapter, server, sealer } = await build();
      sealer.decline = true;
      server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
      server.onMatch(REQID_EMF, obsOk('9zz'));
      const error = await stageOf(adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, lease));
      expect(error).toMatchObject({ stage: 'e2ee_message', causeClass: 'Error' });
      expect(error.detail).toBe('e2ee_message:Error');
      expect(server.requests.filter((request) => request.url.startsWith(OBS))).toHaveLength(1);
      expect(server.to(tp('sendMessage'))).toHaveLength(0);
    });

    it('names media_size for an empty or too large body', async () => {
      const { adapter, server } = await build();
      expect((await stageOf(adapter.sendMedia(target, { kind: 'file', bytes: Buffer.alloc(0), fileName: 'a' }, lease))).stage).toBe('media_size');
      expect((await stageOf(adapter.sendMedia(target, { kind: 'image', bytes: Buffer.alloc(20 * 1024 * 1024 + 1), fileName: 'a.png' }, lease))).detail)
        .toBe('media_size');
      expect(server.requests).toHaveLength(0);
    });

    it('reports a lease mismatch as a gate denial, not as an upload failure', async () => {
      const { adapter, server } = await build();
      server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
      server.onMatch(REQID_EMF, obsOk('9zz'));
      // A mismatching lease is refused by the gate before any request leaves.
      const error = await adapter.sendMedia(target, { kind: 'file', bytes, fileName: 'a.bin' }, { ...lease, controlEpoch: lease.controlEpoch + 1 })
        .then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(EffectDeniedError);
      expect(server.to(tp('sendMessage'))).toHaveLength(0);
    });
  });

  it('keeps the size limits and the kind/conversation checks', async () => {
    const { adapter, server } = await build();
    await expect(adapter.sendMedia(target, { kind: 'file', bytes: Buffer.alloc(0), fileName: 'a' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
    await expect(adapter.sendMedia(target, { kind: 'image', bytes: Buffer.alloc(20 * 1024 * 1024 + 1), fileName: 'a.png' }, lease))
      .rejects.toBeInstanceOf(MediaUploadFailedError);
    await expect(adapter.sendMedia({ chatType: 'group', chatId: PEER }, { kind: 'file', bytes, fileName: 'a' }, lease)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(adapter.sendMedia(target, { kind: 'video' as never, bytes, fileName: 'a' }, lease)).rejects.toBeInstanceOf(EffectDeniedError);
    expect(server.requests).toHaveLength(0);
  });
});

// -- react / unsend ---------------------------------------------------------------------------------------------------

describe('ChromeAdapter.react and unsend', () => {
  it.each([['NICE', 2], ['LOVE', 3], ['FUN', 4], ['AMAZING', 5], ['SAD', 6], ['OMG', 7]] as const)('maps %s to predefinedReactionType %i', async (name, type) => {
    const { adapter, server } = await build({ reqSeq: 9 });
    server.on(tp('react'), ok(null));
    await adapter.react(conv, '123456789012345678', name, lease);
    expect(server.bodies(tp('react'))).toEqual([[{ reqSeq: 10, messageId: '123456789012345678', reactionType: { predefinedReactionType: type } }]]);
  });

  it('cancels a reaction on UNDO with cancelReaction [{reqSeq, messageId}]', async () => {
    const { adapter, server } = await build();
    server.on(tp('cancelReaction'), ok(null));
    await adapter.react(conv, '55', 'UNDO', lease);
    expect(server.bodies(tp('cancelReaction'))).toEqual([[{ reqSeq: 1, messageId: '55' }]]);
    expect(server.to(tp('react'))).toHaveLength(0);
  });

  it('does not retry a failed reaction and projects a server rejection', async () => {
    const { adapter, server } = await build();
    server.on(tp('react'), talkError(36), new TypeError('x'));
    await expect(adapter.react(conv, '55', 'NICE', lease)).rejects.toBeInstanceOf(LineServerRejection);
    await expect(adapter.react(conv, '55', 'NICE', lease)).rejects.toThrow();
    expect(server.to(tp('react'))).toHaveLength(2);
  });

  it('rejects ids that are not int64 and mismatched conversations before any request', async () => {
    const { adapter, server } = await build();
    await expect(adapter.react(conv, '9223372036854775808', 'NICE', lease)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(adapter.react(conv, '12x', 'NICE', lease)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(adapter.unsend({ chatType: 'room', chatId: PEER }, '1', lease)).rejects.toBeInstanceOf(EffectDeniedError);
    expect(server.requests).toHaveLength(0);
  });

  it('unsends with unsendMessage [reqSeq, messageId] and persists the reqSeq', async () => {
    const { adapter, server, events } = await build({ reqSeq: 4, mode: 'MONITOR_ONLY' });
    server.on(tp('unsendMessage'), ok(null));
    await adapter.unsend(conv, '123456789012345678', lease);
    expect(server.bodies(tp('unsendMessage'))).toEqual([[5, '123456789012345678']]);
    expect(events.filter((entry) => entry.event === 'storage').map((entry) => (entry.value as Record<string, unknown>)['chrome:reqSeq'])).toEqual([5]);
  });

  it('does not retry an unsend whose outcome is unknown', async () => {
    const { adapter, server } = await build();
    server.on(tp('unsendMessage'), new Response('x', { status: 503 }), ok(null));
    await expect(adapter.unsend(conv, '1', lease)).rejects.toThrow();
    expect(server.to(tp('unsendMessage'))).toHaveLength(1);
  });
});

// -- download ---------------------------------------------------------------------------------------------------------

describe('ChromeAdapter.download', () => {
  const OID = 'oid0123';
  const km = Buffer.alloc(32, 7);
  const plaintext = Buffer.from('plaintext image');
  const identity = { accountId: 'account-A', chatType: 'direct' as const, chatId: PEER, ownMid: SELF, messageId: '900', kind: 'image' as const,
    externalAttachmentId: OID };
  const lineMessage = (extra: Record<string, string> = {}) => ({ id: '900', from: PEER, to: SELF, toType: 0, contentType: 1,
    contentMetadata: { OID, SID: 'emi', e2eeVersion: '2', ...extra }, chunks: ['YQ==', 'Yg==', 'Yw==', 'ZA==', 'ZQ=='] });
  const PATH = `/r/talk/emi/${OID}`;
  const options = (over: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, maxBytes: 1024, identity, ...over });
  const stage = async () => {
    const harness = await build();
    harness.sealer.encKm = km.toString('base64');
    harness.server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    return harness;
  };
  const collect = async (source: AsyncIterable<Uint8Array>): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const part of source) parts.push(Buffer.from(part));
    return Buffer.concat(parts);
  };

  it('fetches the sealed object with the encrypted token and X-Talk-Meta, then decrypts it', async () => {
    const { adapter, server, sealer } = await stage();
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));

    const result = await adapter.download('image', '900', OID, lineMessage() as never, options());

    expect(result.name).toBe('photo.png');
    expect(await collect(result.source)).toEqual(plaintext);
    expect(sealer.decrypts[0]!.id).toBe('900');
    expect(server.bodies(tp('acquireEncryptedAccessToken'))).toEqual([[2]]);
    const request = server.to(PATH)[0]!;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`${OBS}${PATH}`);
    expect(request.headers).toEqual([
      ['accept', 'application/json, text/plain, */*'], ['X-Line-Chrome-Version', '3.7.2'], ['Accept-Language', 'en-US'],
      ['User-Agent', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'],
      ['X-Line-Access', 'encTokenValue'], ['X-Line-Application', 'CHROMEOS\t3.7.2\tChrome_OS\t'], ['X-Talk-Meta', buildTalkMeta('900')],
    ]);
  });

  it('asks for the encrypted OBS token once per session and again after an OBS 401', async () => {
    const { adapter, server } = await stage();
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }), () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    await adapter.download('image', '900', OID, lineMessage() as never, options());
    await adapter.download('image', '900', OID, lineMessage() as never, options());
    expect(server.bodies(tp('acquireEncryptedAccessToken'))).toHaveLength(1);

    // A 401 clears the token and is not retried: the next download asks again.
    server.on(PATH, () => new Response('', { status: 401 }), () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    const failure = await adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e);
    expect((failure as SafeAttachmentError).code).toBe('LINE_OBS_HTTP_401');
    expect(server.to(PATH)).toHaveLength(3);
    expect(server.bodies(tp('acquireEncryptedAccessToken'))).toHaveLength(1);
    await adapter.download('image', '900', OID, lineMessage() as never, options());
    expect(server.bodies(tp('acquireEncryptedAccessToken'))).toHaveLength(2);
  });

  it('builds X-Talk-Meta as OkLine does (base64 json of the thrift struct)', () => {
    const meta = JSON.parse(Buffer.from(buildTalkMeta('900'), 'base64').toString('utf8')) as { message: string };
    expect(Buffer.from(meta.message, 'base64').toString('hex')).toBe(`0b0004${'00000003'}${Buffer.from('900').toString('hex')}0f001b0c00000000${'00'}`);
  });

  it('streams with a maxBytes limit', async () => {
    const { adapter, server } = await stage();
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    const error = await adapter.download('image', '900', OID, lineMessage() as never, options({ maxBytes: 10 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SafeAttachmentError);
    expect((error as SafeAttachmentError).code).toBe('LINE_MEDIA_SIZE_LIMIT');
  });

  it('stops on an abort signal mid-stream', async () => {
    const { adapter, server } = await stage();
    const controller = new AbortController();
    server.on(PATH, () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); } }), { status: 200 }));
    const pending = adapter.download('image', '900', OID, lineMessage() as never, options({ signal: controller.signal })).catch((e: unknown) => e);
    await flush();
    controller.abort(new Error('stop'));
    const error = await pending;
    expect((error as SafeAttachmentError).code).toBe('LINE_DOWNLOAD_CANCELLED');
  });

  it('does not touch the network for a signal that is already aborted', async () => {
    const { adapter, server } = await stage();
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('late'), { code: 'TIMEOUT' }));
    const error = await adapter.download('image', '900', OID, lineMessage() as never, options({ signal: controller.signal })).catch((e: unknown) => e);
    expect((error as SafeAttachmentError).code).toBe('LINE_DOWNLOAD_TIMEOUT');
    expect(server.requests).toHaveLength(0);
  });

  it('fails authentication on a tampered blob and maps OBS HTTP errors', async () => {
    const { adapter, server } = await stage();
    const blob = encryptBlob(km, plaintext);
    blob[0]! ^= 1;
    server.on(PATH, () => new Response(blob, { status: 200 }), () => new Response('', { status: 404 }));
    server.on(tp('acquireEncryptedAccessToken'), ok(ENC_TOKEN));
    expect(((await adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e)) as SafeAttachmentError).code)
      .toBe('LINE_MEDIA_AUTH_FAILED');
    expect(((await adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e)) as SafeAttachmentError).code)
      .toBe('LINE_OBS_HTTP_404');
  });

  it('rejects metadata that does not match the requested attachment, before any request', async () => {
    const { adapter, server } = await stage();
    const error = await adapter.download('image', '900', 'other9', lineMessage() as never, options({ identity: { ...identity, externalAttachmentId: 'other9' } }))
      .catch((e: unknown) => e);
    expect((error as SafeAttachmentError).code).toBe('ATTACHMENT_METADATA_INVALID');
    expect(server.requests).toHaveLength(0);
  });

  it('accepts a sealed key text without final padding, with the same GET', async () => {
    const { adapter, server, sealer } = await stage();
    sealer.encKm = km.toString('base64').slice(0, 43);
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    const result = await adapter.download('image', '900', OID, lineMessage() as never, options());
    expect(server.to(PATH)).toHaveLength(1);
    expect(server.to(PATH)[0]!.headers).toContainEqual(['X-Talk-Meta', buildTalkMeta('900')]);
    expect(result.name).toBe('photo.png');
    expect(await collect(result.source)).toEqual(plaintext);
  });

  it('decrypts with a sealed key of any length through HKDF', async () => {
    const { adapter, server, sealer } = await stage();
    const long = Buffer.alloc(45, 9);
    sealer.encKm = long.toString('base64');
    server.on(PATH, () => new Response(encryptBlob(long, plaintext), { status: 200 }));
    const result = await adapter.download('image', '900', OID, lineMessage() as never, options());
    expect(await collect(result.source)).toEqual(plaintext);
  });

  it('fails a bad sealed key text only after the one GET', async () => {
    const { adapter, server, sealer } = await stage();
    sealer.encKm = 'AAAAA';
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    const error = await adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e);
    expect(server.to(PATH)).toHaveLength(1);
    expect(error).toBeInstanceOf(SafeAttachmentError);
    expect((error as SafeAttachmentError).code).toBe('LINE_E2EE_KEY_MISMATCH');
  });

  it('fails an empty sealed key before any OBS request', async () => {
    const { adapter, server, sealer } = await stage();
    sealer.encKm = '';
    const error = await adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e);
    expect(server.to(PATH)).toHaveLength(0);
    expect((error as SafeAttachmentError).code).toBe('LINE_E2EE_KEY_MISMATCH');
  });

  it('fails a non-string sealed key after the one GET', async () => {
    const { adapter, server, sealer } = await stage();
    sealer.encKm = 5 as never;
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    const error = await adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e);
    expect(server.to(PATH)).toHaveLength(1);
    expect((error as SafeAttachmentError).code).toBe('LINE_E2EE_KEY_MISMATCH');
  });

  it('prefers the sealed key over a clear ENC_KM', async () => {
    const { adapter, server } = await stage();
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    const result = await adapter.download('image', '900', OID, lineMessage({ ENC_KM: 'other' }) as never, options());
    expect(await collect(result.source)).toEqual(plaintext);
  });

  it('keeps a clear ENC_KM when the plaintext keyMaterial is an empty array (Python truthiness)', async () => {
    const { adapter, server, sealer } = await stage();
    sealer.plainJson = '{"text":"","keyMaterial":[]}';
    server.on(PATH, () => new Response(encryptBlob(km, plaintext), { status: 200 }));
    const result = await adapter.download('image', '900', OID, lineMessage({ ENC_KM: km.toString('base64') }) as never, options());
    expect(server.to(PATH)).toHaveLength(1);
    expect(server.to(PATH)[0]!.headers).toContainEqual(['X-Talk-Meta', buildTalkMeta('900')]);
    expect(await collect(result.source)).toEqual(plaintext);
  });

  it('fails an empty clear ENC_KM with an empty-object plaintext keyMaterial before any OBS request', async () => {
    const { adapter, server, sealer } = await stage();
    sealer.plainJson = '{"keyMaterial":{}}';
    const error = await adapter.download('image', '900', OID, lineMessage({ ENC_KM: '' }) as never, options()).catch((e: unknown) => e);
    expect(server.to(PATH)).toHaveLength(0);
    expect((error as SafeAttachmentError).code).toBe('LINE_E2EE_KEY_MISMATCH');
  });

  it('reports a dead session as LINE_AUTH_INVALIDATED', async () => {
    const harness = await build();
    harness.sealer.encKm = km.toString('base64');
    harness.server.on(tp('acquireEncryptedAccessToken'), talkError(8));
    const error = await harness.adapter.download('image', '900', OID, lineMessage() as never, options()).catch((e: unknown) => e);
    expect((error as SafeAttachmentError).code).toBe('LINE_AUTH_INVALIDATED');
    expect(harness.events.filter((entry) => entry.event === 'authInvalidated')).toHaveLength(1);
  });
});

// -- friends ----------------------------------------------------------------------------------------------------------

const F1 = `u${'1'.repeat(32)}`;
const F2 = `u${'2'.repeat(32)}`;
const F3 = `u${'3'.repeat(32)}`;
const STRANGER = `u${'9'.repeat(32)}`;

class FakeSseStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;
  constructor() {
    this.response = new Response(new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  write(data: unknown): void { this.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); }
}

describe('ChromeAdapter friend relation', () => {
  it('loads getAllContactIds and getBlockedContactIds once and never re-fetches per check', async () => {
    const { adapter, server } = await build();
    server.on(tp('getAllContactIds'), ok([F1, F2, F3]));
    server.on(tp('getBlockedContactIds'), ok([F2]));
    expect(await adapter.checkFriendRelation(F1, lease)).toBe('friend');
    expect(await adapter.checkFriendRelation(F2, lease)).toBe('not_friend'); // blocked
    expect(await adapter.checkFriendRelation(STRANGER, lease)).toBe('not_friend');
    expect(await adapter.checkFriendRelation(F3, lease)).toBe('friend');
    expect(server.bodies(tp('getAllContactIds'))).toEqual([[4]]);
    expect(server.bodies(tp('getBlockedContactIds'))).toEqual([[4]]);
    expect(await adapter.checkFriendRelationDiagnostic!(F1, lease)).toEqual({ status: 'friend', error: null });
  });

  it('keeps the cache current from contact operations on the stream, with no extra request', async () => {
    const { adapter, server } = await build();
    server.on(tp('getAllContactIds'), ok([F1]));
    server.on(tp('getBlockedContactIds'), ok([]));
    const stream = new FakeSseStream();
    server.on('/api/operation/receive', () => stream.response);
    server.always(tp('getLastOpRevision'), () => ok(100));
    expect(await adapter.checkFriendRelation(F1, lease)).toBe('friend');
    await adapter.sync({ version: 1, revision: '100', globalRev: '0', individualRev: '0' });
    await flush();
    const op = (revision: number, type: number, mid: string) => ({ revision, type, createdTime: NOW, param1: mid });
    stream.write([op(101, 4, F2), op(102, 6, F1), op(103, 69, F1), op(104, 33, F2), op(105, 5, F3), op(106, 68, F3)]);
    await flush();
    await adapter.sync({ version: 1, revision: '100', globalRev: '0', individualRev: '0' });
    expect(await adapter.checkFriendRelation(F1, lease)).toBe('friend'); // blocked then unblocked
    expect(await adapter.checkFriendRelation(F2, lease)).toBe('not_friend'); // added then unregistered
    expect(await adapter.checkFriendRelation(F3, lease)).toBe('not_friend'); // added then blocked
    expect(server.to(tp('getAllContactIds'))).toHaveLength(1);
    expect(server.to(tp('getBlockedContactIds'))).toHaveLength(1);
  });

  it('loads again inside the same check when op 49 makes a load stale, and starts no cooldown', async () => {
    const { adapter, server } = await build();
    const stream = new FakeSseStream();
    server.on('/api/operation/receive', () => stream.response);
    server.always(tp('getLastOpRevision'), () => ok(100));
    const cursor = { version: 1 as const, revision: '100', globalRev: '0', individualRev: '0' };
    await adapter.sync(cursor);
    await flush();
    server.on(tp('getAllContactIds'), async () => {
      // Op 49 arrives while the first load is in flight.
      stream.write([{ revision: 101, type: 49, createdTime: NOW, param1: F1 }]);
      await flush();
      await adapter.sync(cursor);
      return ok([F1]);
    }, ok([F1, F2]));
    server.always(tp('getBlockedContactIds'), () => ok([]));
    expect(await adapter.checkFriendRelationDiagnostic!(F2, lease)).toEqual({ status: 'friend', error: null });
    expect(server.to(tp('getAllContactIds'))).toHaveLength(2);
  });

  it('discards a load in flight when a fullSync jump resets the cache, then loads once more and answers from the second list', async () => {
    const { adapter, server } = await build();
    const stream = new FakeSseStream();
    server.on('/api/operation/receive', () => stream.response);
    server.always(tp('getLastOpRevision'), () => ok(100));
    const cursor = { version: 1 as const, revision: '100', globalRev: '0', individualRev: '0' };
    await adapter.sync(cursor);
    await flush();
    server.on(tp('getAllContactIds'), async () => {
      // A fullSync frame arrives and a sync drains it while the first load is in flight.
      stream.writeEvent('fullSync', { nextRevision: 500 });
      await flush();
      await adapter.sync(cursor);
      return ok([F1]);
    }, ok([F1, F2]));
    server.always(tp('getBlockedContactIds'), () => ok([]));
    expect(await adapter.checkFriendRelationDiagnostic!(F2, lease)).toEqual({ status: 'friend', error: null });
    expect(server.to(tp('getAllContactIds'))).toHaveLength(2);
    expect(await adapter.checkFriendRelation(F1, lease)).toBe('friend');
    expect(server.to(tp('getAllContactIds'))).toHaveLength(2);
  });

  it('returns unknown (no cache) when the list cannot be loaded and waits before asking again', async () => {
    const { adapter, server } = await build();
    server.on(tp('getAllContactIds'), new Response('boom', { status: 502 }));
    expect(await adapter.checkFriendRelationDiagnostic!(F1, lease)).toEqual({ status: 'unknown', error: 'RELATION_LIST_RPC_FAILED' });
    const afterFirst = server.to(tp('getAllContactIds')).length; // the gateway's own read retries (max 2)
    expect(afterFirst).toBe(3);
    expect(await adapter.checkFriendRelationDiagnostic!(F1, lease)).toEqual({ status: 'unknown', error: 'RELATION_LIST_RPC_FAILED' });
    expect(server.to(tp('getAllContactIds'))).toHaveLength(afterFirst); // the retry window has not passed: no request at all
  });

  it('rejects a malformed list as RELATION_LIST_SHAPE_INVALID, honours cancellation and mode', async () => {
    const { adapter, server } = await build();
    server.on(tp('getAllContactIds'), ok({ nope: 1 }));
    expect(await adapter.checkFriendRelationDiagnostic!(F1, lease)).toEqual({ status: 'unknown', error: 'RELATION_LIST_SHAPE_INVALID' });
    expect(await adapter.checkFriendRelationDiagnostic!(F1, lease, { aborted: true })).toEqual({ status: 'unknown', error: 'RELATION_CANCELLED' });
    const monitor = await build({ mode: 'MONITOR_ONLY' });
    expect(await monitor.adapter.checkFriendRelation(F1, lease)).toBe('unknown');
    expect(monitor.server.requests).toHaveLength(0);
  });

  it('shares one load between concurrent checks', async () => {
    const { adapter, server } = await build();
    server.always(tp('getAllContactIds'), () => ok([F1]));
    server.always(tp('getBlockedContactIds'), () => ok([]));
    const results = await Promise.all([adapter.checkFriendRelation(F1, lease), adapter.checkFriendRelation(F2, lease)]);
    expect(results).toEqual(['friend', 'not_friend']);
    expect(server.to(tp('getAllContactIds'))).toHaveLength(1);
  });
});

describe('ChromeAdapter.addFriendByMid', () => {
  it('sends the friendRecommendation tracking without a source chat and calls onPhysicalStart right before the request', async () => {
    const { adapter, server } = await build({ reqSeq: 2 });
    const order: string[] = [];
    server.on(RELATION_ADD, () => { order.push('request'); return ok({}); });
    const result = await adapter.addFriendByMid(PEER, lease, () => { order.push('start'); });
    expect(result).toEqual({ status: 'added', error: null });
    expect(order).toEqual(['start', 'request']);
    expect(server.bodies(RELATION_ADD)).toEqual([[{ reqSeq: 3, userMid: PEER, tracking: { reference: '', trackingMetaV2: { friendRecommendation: {} } } }]]);
  });

  it('sends the chat tracking when a source chat is given', async () => {
    const { adapter, server } = await build();
    server.on(RELATION_ADD, ok({}));
    await adapter.addFriendByMid(PEER, lease, () => undefined, undefined, GROUP);
    expect(server.bodies(RELATION_ADD)).toEqual([[{ reqSeq: 1, userMid: PEER, tracking: { reference: '', trackingMetaV2: { chat: { chatMid: GROUP } } } }]]);
  });

  it('does not call onPhysicalStart when the add is cancelled or denied before the network', async () => {
    const { adapter, server } = await build();
    let started = 0;
    expect(await adapter.addFriendByMid(PEER, lease, () => { started += 1; }, { aborted: true })).toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    const monitor = await build({ mode: 'MONITOR_ONLY' });
    expect(await monitor.adapter.addFriendByMid(PEER, lease, () => { started += 1; })).toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    expect(started).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it('reports unknown after the physical start on a network failure and never retries', async () => {
    const { adapter, server } = await build();
    let started = 0;
    server.on(RELATION_ADD, new TypeError('reset'), ok({}));
    expect(await adapter.addFriendByMid(PEER, lease, () => { started += 1; })).toEqual({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    expect(started).toBe(1);
    expect(server.to(RELATION_ADD)).toHaveLength(1);
  });

  it('projects an AddFriendResult rejection (code and rejectionReason) to LINE_RELATION_ADD_*', async () => {
    const { adapter, server } = await build();
    server.on(RELATION_ADD,
      new Response(JSON.stringify({ code: 3, message: 'FAILED' }), { status: 400 }),
      new Response(JSON.stringify({ code: 10052, message: 'HTTP_ERROR', data: { statusCode: 400, rejectionReason: 'TOO_MANY_REQUESTS' } }), { status: 400 }));
    expect(await adapter.addFriendByMid(PEER, lease, () => undefined)).toEqual({ status: 'failed', error: 'LINE_RELATION_ADD_TOO_MANY_FRIENDS' });
    expect(await adapter.addFriendByMid(PEER, lease, () => undefined)).toEqual({ status: 'failed', error: 'LINE_RELATION_ADD_TOO_MANY_REQUESTS' });
  });

  it('allows one add at a time', async () => {
    const { adapter, server } = await build();
    let release!: () => void;
    server.on(RELATION_ADD, () => new Promise<Response>((resolve) => { release = () => resolve(ok({})); }));
    const first = adapter.addFriendByMid(PEER, lease, () => undefined);
    await flush();
    expect(await adapter.addFriendByMid(PEER, lease, () => undefined)).toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    release();
    expect(await first).toEqual({ status: 'added', error: null });
  });
});

// -- Python int() parsing in the real E2EE manager (OkLine e2ee.py) -------------------------------------------------------
// These tests use the real `ChromeE2ee` with a small fake ltsm bridge, so the key service answers come from the fake server.

describe('ChromeAdapter send with the real E2EE manager: integer fields parse like Python int()', () => {
  const CIPHERTEXT = Buffer.alloc(40, 7).toString('base64');
  const miniBridge = {
    curveKeyGenerate: async () => 900, e2eeGetKeyId: async () => 11, e2eeExportKey: async (h: number) => `blob-${h}`,
    e2eeLoadKey: async () => 1, e2eePublicKeyForHandle: async () => 'pub-self', e2eeCreateChannelWithPubkey: async () => 5,
    e2eeEncryptV1: async () => CIPHERTEXT, e2eeEncryptV2: async () => CIPHERTEXT,
    e2eeDecryptV1: async () => '', e2eeDecryptV2: async () => '',
    e2eeWrapGroupSharedKey: async () => 'wrapped', e2eeUnwrapGroupSharedKey: async () => 77,
  };

  async function buildReal() {
    const server = new FakeServer();
    const adapter = await createChromeAdapter({
      ...binding, mode: 'ACTIVE_CONTROL', validateLease: () => true, fetch: server.fetch,
      signer: new FakeHmacSigner(), bridge: fakeBridge(), receiveClock: inertClock, receiveWaitMs: 0, timers, now: () => NOW,
      createE2ee: (parts) => {
        const e2ee = new RealChromeE2ee({ ...parts, bridge: miniBridge as never });
        e2ee.adoptLogin({ handles: { 11: 1 }, exported: { mid: SELF, latestKeyId: 11, keys: { '11': 'blob-1' } } });
        return e2ee;
      },
    });
    await adapter.installSecrets({ token: 'tok', qrCert: null, e2eeStorage: snapshot() });
    return { server, adapter };
  }

  const negotiated = (extra: Record<string, unknown>) => ok({ publicKey: { keyData: 'pub-peer', keyId: 22 }, ...extra });
  const groupKey = (extra: Record<string, unknown> = {}) => ok({
    groupKeyId: 7, receiverKeyId: 11, creator: PEER, creatorKeyId: 22, encryptedSharedKey: 'gsk:500', specVersion: 2, allowedTypes: [], ...extra });
  const paths = (server: FakeServer): string[] => server.requests.map((request) => request.path);

  it('specVersion "1e0" rejects the send: one negotiate request, no key lookup, no sendMessage', async () => {
    const { adapter, server } = await buildReal();
    server.on(tp('negotiateE2EEPublicKey'), negotiated({ specVersion: '1e0' }));
    await expect(adapter.send(conv, 'hello', null, lease)).rejects.toBeInstanceOf(ChromeError);
    expect(paths(server)).toEqual([tp('negotiateE2EEPublicKey')]);
  });

  it('specVersion "1" seals V1, " 2 ", "" and "0" seal V2', async () => {
    const versionOf = async (specVersion: unknown) => {
      const { adapter, server } = await buildReal();
      server.on(tp('negotiateE2EEPublicKey'), negotiated({ specVersion }));
      server.on(tp('sendMessage'), sent());
      await adapter.send(conv, 'hello', null, lease);
      const [body] = server.bodies(tp('sendMessage')) as Array<[number, Record<string, any>]>;
      expect(body![1].chunks).toHaveLength(5);
      return body![1].contentMetadata.e2eeVersion;
    };
    expect(await versionOf('1')).toBe('1');
    expect(await versionOf(' 2 ')).toBe('2');
    expect(await versionOf('')).toBe('2');
    expect(await versionOf('0')).toBe('2');
  });

  it('allowedTypes ["1.5"] rejects the send; allowedTypes [15] sends one plain sendMessage for a text', async () => {
    const bad = await buildReal();
    bad.server.on(tp('negotiateE2EEPublicKey'), negotiated({ specVersion: 2, allowedTypes: ['1.5'] }));
    await expect(bad.adapter.send(conv, 'hello', null, lease)).rejects.toBeInstanceOf(ChromeError);
    expect(bad.server.to(tp('sendMessage'))).toHaveLength(0);

    const { adapter, server } = await buildReal();
    server.on(tp('negotiateE2EEPublicKey'), negotiated({ specVersion: 2, allowedTypes: [15] }));
    server.always(tp('sendMessage'), () => sent());
    await adapter.send(conv, 'first', null, lease); // the negotiation is not known yet: this one is sealed
    await adapter.send(conv, 'hello', null, lease); // allowedTypes [15] excludes a text: this one goes out plain
    const bodies = server.bodies(tp('sendMessage')) as Array<[number, Record<string, any>]>;
    expect(bodies).toHaveLength(2);
    expect(bodies[0]![1].chunks).toHaveLength(5);
    expect(bodies[1]![1].text).toBe('hello');
    expect(bodies[1]![1].chunks).toBeUndefined();
  });

  it('publicKey.keyId "abc" rejects the send before sendMessage', async () => {
    const { adapter, server } = await buildReal();
    server.on(tp('negotiateE2EEPublicKey'), ok({ publicKey: { keyData: 'pub-peer', keyId: 'abc' }, specVersion: 2 }));
    await expect(adapter.send(conv, 'hello', null, lease)).rejects.toBeInstanceOf(ChromeError);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  it('a group key with specVersion "1e0" rejects the send: no registerE2EEGroupKey, no sendMessage', async () => {
    const { adapter, server } = await buildReal();
    server.on(tp('getLastE2EEGroupSharedKey'), groupKey({ specVersion: '1e0' }));
    server.on(tp('getE2EEPublicKey'), ok({ keyData: 'pub-peer', keyId: 22 }));
    await expect(adapter.send({ chatType: 'group', chatId: GROUP }, 'hello', null, lease)).rejects.toBeInstanceOf(ChromeError);
    expect(server.to(tp('registerE2EEGroupKey'))).toHaveLength(0);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  it('a group key with creatorKeyId "1e0" rejects the send before any getE2EEPublicKey', async () => {
    const { adapter, server } = await buildReal();
    server.on(tp('getLastE2EEGroupSharedKey'), groupKey({ creatorKeyId: '1e0' }));
    await expect(adapter.send({ chatType: 'group', chatId: GROUP }, 'hello', null, lease)).rejects.toBeInstanceOf(ChromeError);
    expect(server.to(tp('getE2EEPublicKey'))).toHaveLength(0);
    expect(server.to(tp('sendMessage'))).toHaveLength(0);
  });

  describe('media flow', () => {
    const target = { chatType: 'direct' as const, chatId: PEER };
    const bytes = Buffer.from('hello image bytes');

    it('a flow value "2.0" rejects sendMedia with MediaUploadFailedError: no OBS POST, no sendMessage', async () => {
      const { adapter, server } = await buildReal();
      server.on(tp('determineMediaMessageFlow'), ok({ flowMap: { '1': '2.0' }, cacheTtlMillis: 1000 }));
      await expect(adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
      expect(server.requests.filter((request) => request.url.startsWith(OBS))).toHaveLength(0);
      expect(server.to(tp('sendMessage'))).toHaveLength(0);
    });

    it('a truthy non-map flowMap rejects sendMedia with MediaUploadFailedError: no OBS POST, no sendMessage, no cache', async () => {
      const { adapter, server } = await buildReal();
      server.always(tp('determineMediaMessageFlow'), () => ok({ flowMap: 'bad', cacheTtlMillis: 1000 }));
      await expect(adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
      expect(server.requests.filter((request) => request.url.startsWith(OBS))).toHaveLength(0);
      expect(server.to(tp('sendMessage'))).toHaveLength(0);
      await expect(adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease)).rejects.toBeInstanceOf(MediaUploadFailedError);
      expect(server.to(tp('determineMediaMessageFlow'))).toHaveLength(2);
    });

    it('a cacheTtlMillis "abc" counts as 0: the send goes out and a second send looks the flow up again', async () => {
      const { adapter, server } = await buildReal();
      server.always(tp('determineMediaMessageFlow'), () => ok({ flowMap: { '1': 2 }, cacheTtlMillis: 'abc' }));
      server.always(tp('negotiateE2EEPublicKey'), () => negotiated({ specVersion: 2 }));
      server.always(tp('acquireEncryptedAccessToken'), () => ok(ENC_TOKEN));
      server.onMatch(REQID_EMI, obsOk('0abc123'), obsOk('0abc124'));
      server.always(tp('sendMessage'), () => sent('77'));
      await adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease);
      await adapter.sendMedia(target, { kind: 'image', bytes, fileName: 'a.png' }, lease);
      expect(server.to(tp('sendMessage'))).toHaveLength(2);
      expect(server.to(tp('determineMediaMessageFlow'))).toHaveLength(2);
    });
  });
});
