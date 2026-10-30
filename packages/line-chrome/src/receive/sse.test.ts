import { describe, expect, it } from 'vitest';
import { FakeServer, headerOf, makeGateway, ok, thrift, TOKEN_REFRESH } from '../auth/auth.testkit.js';
import { ChromeSessionState } from '../auth/session-state.js';
import { TokenRefresher } from '../auth/token-refresh.js';
import { ReceiveBuffer } from './receive-buffer.js';
import { ChromeSseReceiver, SSE_BACKOFF_CAP_MS, SSE_MAX_FAILED_ATTEMPTS, sseBackoffMs, type ReceiverState, type SseReceiverOptions } from './sse.js';
import { FakeSseStream, ManualClock, RecordingSink, flush, frame, op } from './receive.testkit.js';

const SSE = '/api/operation/receive';
const LAST_OP = thrift('Talk', 'TalkService', 'getLastOpRevision');
const failing = (): Response => new Response('', { status: 500 });

function setup(options: Partial<SseReceiverOptions> = {}) {
  const clock = new ManualClock();
  const sink = new RecordingSink();
  const server = new FakeServer();
  const session = new ChromeSessionState();
  session.setAccessToken('tok');
  const { gateway, signer } = makeGateway(server, session);
  const states: ReceiverState[] = [];
  const talk: unknown[] = [];
  const errors: unknown[] = [];
  const receiver = new ChromeSseReceiver({
    gateway,
    sink,
    clock,
    getAccessToken: () => session.accessToken ?? undefined,
    onState: (s) => void states.push(s),
    onTalkException: (i) => void talk.push(i),
    onError: (e) => void errors.push(e),
    ...options,
  });
  const queue = (...streams: FakeSseStream[]): void => {
    for (const s of streams) server.on(SSE, () => s.response);
  };
  return { clock, sink, server, session, gateway, signer, states, talk, errors, receiver, queue, requests: () => server.to(SSE).length };
}

describe('sseBackoffMs', () => {
  it('is min(2^n s, 600 s)', () => {
    expect([0, 1, 2, 3, 9, 10, 11, 143, 1000].map(sseBackoffMs)).toEqual([1000, 2000, 4000, 8000, 512000, 600000, 600000, 600000, 600000]);
    expect(SSE_BACKOFF_CAP_MS).toBe(600_000);
    expect(SSE_MAX_FAILED_ATTEMPTS).toBe(144);
  });
});

describe('request shape', () => {
  it('GET with the exact query order, header auth, and X-Hmac over path?query with an empty body', async () => {
    const s = setup({ legyHost: 'legy-jp.example', fullSyncRequestReason: 'INITIALIZATION' });
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('12345');
    await flush();
    const req = s.server.to(SSE)[0]!;
    const query = 'version=3.7.2&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=12345&fullSyncRequestReason=INITIALIZATION&legyHost=legy-jp.example';
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://line-chrome-gw.line-apps.com${SSE}?${query}`);
    expect(req.body).toBeUndefined();
    expect(req.headers.map(([n]) => n)).toEqual(['accept', 'cache-control', 'Accept-Language', 'User-Agent', 'X-Line-Access', 'X-Hmac']);
    expect(headerOf(req, 'accept')).toBe('text/event-stream');
    expect(headerOf(req, 'X-Line-Access')).toBe('tok');
    expect(headerOf(req, 'Cookie')).toBeUndefined();
    expect(s.signer.calls).toEqual([{ accessToken: 'tok', pathWithQuery: `${SSE}?${query}`, body: '' }]);
    expect(s.receiver.state.kind).toBe('open');
    s.receiver.stop();
  });

  it('omits fullSyncRequestReason and legyHost when unset, and uses the locale for `language`', async () => {
    const s = setup({ locale: 'zh-TW' });
    s.queue(new FakeSseStream());
    s.receiver.start('5');
    await flush();
    expect(new URL(s.server.to(SSE)[0]!.url).search).toBe('?version=3.7.2&language=zh_TW&lastPartialFullSyncs=%7B%7D&localRev=5');
    s.receiver.stop();
  });

  it('sends fullSyncRequestReason on the first connect only', async () => {
    const s = setup({ fullSyncRequestReason: 'INITIALIZATION' });
    s.server.on(SSE, failing, failing);
    s.receiver.start('5');
    await flush();
    await s.clock.advance(1000);
    const urls = s.server.to(SSE).map((r) => new URL(r.url).search);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('fullSyncRequestReason=INITIALIZATION');
    expect(urls[1]).not.toContain('fullSyncRequestReason');
    s.receiver.stop();
  });

  it('cookie auth sends only `Cookie: lct=<token>`: no X-Line-Access, no X-Hmac, no signing', async () => {
    const s = setup({ sseAuth: 'cookie' });
    s.queue(new FakeSseStream());
    s.receiver.start('9');
    await flush();
    const req = s.server.to(SSE)[0]!;
    expect(req.headers.map(([n]) => n)).toEqual(['accept', 'cache-control', 'Accept-Language', 'User-Agent', 'Cookie']);
    expect(headerOf(req, 'Cookie')).toBe('lct=tok');
    expect(s.signer.calls).toHaveLength(0);
    s.receiver.stop();
  });

  it('sends no pings: a quiet open stream makes no other request', async () => {
    const s = setup();
    s.queue(new FakeSseStream());
    s.receiver.start('9');
    await flush();
    await s.clock.advance(29_999);
    expect(s.server.requests).toHaveLength(1);
    s.receiver.stop();
  });
});

describe('seeding localRev', () => {
  it('seeds once from getLastOpRevision when the cursor is "0", then announces the epoch', async () => {
    const s = setup();
    s.server.on(LAST_OP, ok(777));
    s.queue(new FakeSseStream());
    s.receiver.start('0');
    await flush();
    expect(s.server.to(LAST_OP)).toHaveLength(1);
    expect(s.server.to(LAST_OP)[0]!.body).toBe('[]');
    expect(new URL(s.server.to(SSE)[0]!.url).searchParams.get('localRev')).toBe('777');
    expect(s.sink.epochs).toEqual(['777']);
    s.receiver.stop();
  });

  it('keeps a seeded revision beyond 2^53 as a decimal string', async () => {
    const s = setup();
    s.server.on(LAST_OP, new Response('{"message":"OK","data":9007199254740993}', { status: 200 }));
    s.queue(new FakeSseStream());
    s.receiver.start('0');
    await flush();
    expect(new URL(s.server.to(SSE)[0]!.url).searchParams.get('localRev')).toBe('9007199254740993');
    s.receiver.stop();
  });

  it('does not seed for a real cursor, and does not seed again on reconnect', async () => {
    const s = setup();
    const first = new FakeSseStream();
    s.queue(first, new FakeSseStream());
    s.receiver.start('50');
    await flush();
    first.write(frame([op(51)]));
    await flush();
    first.end();
    await flush();
    expect(s.requests()).toBe(2);
    expect(s.server.to(LAST_OP)).toHaveLength(0);
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('51');
    expect(s.sink.epochs).toEqual(['50']);
    s.receiver.stop();
  });
});

describe('seed across an overflow reopen', () => {
  it('sync(0) seeds 100, an overflow drops the operations, the next sync(0) reopens at 100 with no second seed', async () => {
    const buffer = new ReceiveBuffer({ clock: new ManualClock() });
    const s = setup({ sink: buffer });
    buffer.attach(s.receiver);
    s.server.on(LAST_OP, ok(100), ok(5000));
    const stream = new FakeSseStream();
    s.queue(stream, new FakeSseStream());
    await buffer.drain('0');
    await flush();
    expect(s.server.to(LAST_OP)).toHaveLength(1);
    stream.write(frame(Array.from({ length: 1001 }, (_, i) => op(101 + i))));
    await flush();
    expect(buffer.overflows).toBe(1);
    const again = await buffer.drain('0');
    await flush();
    expect(again.reopened).toBe(true);
    expect(s.server.to(LAST_OP)).toHaveLength(1);
    expect(s.server.to(SSE)).toHaveLength(2);
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('100');
    s.receiver.stop();
  });

  it('a new start() seeds again', async () => {
    const s = setup();
    s.server.on(LAST_OP, ok(100), ok(200));
    s.queue(new FakeSseStream(), new FakeSseStream(), new FakeSseStream());
    s.receiver.start('0');
    await flush();
    s.receiver.reopen('0');
    await flush();
    expect(s.server.to(LAST_OP)).toHaveLength(1);
    expect(s.receiver.localRev).toBe('100');
    s.receiver.start('0');
    await flush();
    expect(s.server.to(LAST_OP)).toHaveLength(2);
    expect(s.receiver.localRev).toBe('200');
    s.receiver.stop();
  });
});

describe('events', () => {
  it('delivers a list, {operations:[...]} and a single op; drops stale ones; advances localRev', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write(frame([op(11), op(12)]));
    stream.write(frame({ operations: [op(13)] }));
    stream.write(frame(op(14)));
    stream.write(frame([op(9), op(10), op(14), op(15)])); // stale, stale, duplicate, fresh
    await flush();
    expect(s.sink.operations.map((o) => o.revision)).toEqual([11, 12, 13, 14, 15]);
    expect(s.receiver.localRev).toBe('15');
    s.receiver.stop();
  });

  it('keeps ids and revisions beyond 2^53 as decimal strings', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write('data: [{"revision":9007199254740993,"type":26,"message":{"id":9007199254740995}}]\n\n');
    await flush();
    expect(s.sink.operations[0]).toMatchObject({ revision: '9007199254740993', message: { id: '9007199254740995' } });
    expect(s.receiver.localRev).toBe('9007199254740993');
    s.receiver.stop();
  });

  it('ignores ping, connInfoRevision, malformed data and an op list without revisions', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write(frame({}, 'ping'));
    stream.write(frame({ revision: 99 }, 'connInfoRevision'));
    stream.write('data: {not json\n\n');
    stream.write(frame([{ type: 26 }]));
    stream.write(frame({ foo: 1 }));
    await flush();
    expect(s.sink.operations).toEqual([]);
    expect(s.receiver.localRev).toBe('10');
    s.receiver.stop();
  });

  it('fullSync and partialFullSync nextRevision jump the cursor (never backwards)', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write(frame({ nextRevision: 500 }, 'fullSync'));
    await flush();
    expect(s.sink.jumps).toEqual(['500']);
    expect(s.receiver.localRev).toBe('500');
    stream.write(frame({ nextRevision: 400 }, 'partialFullSync'));
    stream.write(frame({ nextRevision: '9007199254740993' }, 'partialFullSync'));
    stream.write(frame([op(450), op(9007199254740994)])); // 450 is now stale
    await flush();
    expect(s.sink.jumps).toEqual(['500', '9007199254740993']);
    expect(s.sink.operations.map((o) => o.revision)).toEqual(['9007199254740994']);
    s.receiver.stop();
  });

  it('a `reconnect` event does nothing: the stream stays open and the frame counts as an event', async () => {
    const s = setup();
    const first = new FakeSseStream();
    s.queue(first, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    first.write(frame([op(11)]));
    first.write(frame({}, 'reconnect'));
    await flush();
    expect(s.requests()).toBe(1);
    expect(first.closed).toBe(false);
    expect(s.receiver.state).toMatchObject({ kind: 'open' });
    expect(s.sink.operations.map((o) => o.revision)).toEqual([11]);
    // The server closes the stream later: a connection that delivered events reconnects at once, without a backoff.
    first.end();
    await flush();
    expect(s.requests()).toBe(2);
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('11');
    s.receiver.stop();
  });

  it('delivers operations from an unknown event name', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write(frame([op(11)], 'somethingNew'));
    await flush();
    expect(s.sink.operations.map((o) => o.revision)).toEqual([11]);
    s.receiver.stop();
  });
});

describe('talkException', () => {
  it('an auth code is diagnostics only: the stream stays open and the receiver does not stop', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write(frame({ name: 'TalkException', code: 8, reason: 'NOT_AUTHORIZED_DEVICE' }, 'talkException'));
    await flush();
    expect(s.talk).toMatchObject([{ code: 8 }]);
    expect(s.receiver.state).toMatchObject({ kind: 'open' });
    expect(stream.closed).toBe(false);
    expect(s.requests()).toBe(1);
    s.receiver.stop();
  });

  it('does not count as an event: a later close backs off with one failure', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    stream.write(frame({ code: 119, reason: 'MUST_REFRESH' }, 'talkException'));
    await flush();
    expect(s.talk).toMatchObject([{ code: 119 }]);
    expect(s.receiver.state).toMatchObject({ kind: 'open' });
    stream.end();
    await flush();
    expect(s.receiver.state).toMatchObject({ kind: 'backoff', failures: 1, delayMs: 1000 });
    await s.clock.advance(1000);
    expect(s.requests()).toBe(2);
    s.receiver.stop();
  });

  it('parses operations from the payload like any other event', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream);
    s.receiver.start('10');
    await flush();
    stream.write(frame([op(11)], 'talkException'));
    await flush();
    expect(s.sink.operations.map((o) => o.revision)).toEqual([11]);
    s.receiver.stop();
  });
});

describe('silence watchdog and backoff (design ruling 4)', () => {
  it('reopens after 30 s without an event; a watchdog on a silent connection counts as a failure', async () => {
    const s = setup();
    const quiet = new FakeSseStream();
    s.queue(quiet, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    await s.clock.advance(29_999);
    expect(s.requests()).toBe(1);
    await s.clock.advance(1);
    expect(quiet.closed).toBe(true);
    expect(s.requests()).toBe(1); // backing off 1 s: the connection produced no event
    expect(s.receiver.state).toMatchObject({ kind: 'backoff', failures: 1, delayMs: 1000 });
    await s.clock.advance(1000);
    expect(s.requests()).toBe(2);
    s.receiver.stop();
  });

  it('any received event re-arms the watchdog', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    await s.clock.advance(20_000);
    stream.write(frame({}, 'ping'));
    await flush();
    await s.clock.advance(20_000); // 40 s since open, 20 s since the ping
    expect(s.requests()).toBe(1);
    await s.clock.advance(10_000);
    expect(s.requests()).toBe(2); // a connection that DID deliver an event reconnects immediately
    s.receiver.stop();
  });

  it('a frame ended by a double CR is delivered at once and advances localRev before the reconnect', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    stream.write('data: [{"revision":101,"type":26,"message":{"id":"1","to":"u1","from":"u2","text":"x"}}]\r\r');
    await flush();
    expect(s.sink.operations.map((o) => o.revision)).toEqual([101]);
    expect(s.receiver.localRev).toBe('101');
    stream.end();
    await flush();
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('101');
    s.receiver.stop();
  });

  it('a double CR frame is delivered before the watchdog fires and the reconnect carries its revision', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    stream.write('data: [{"revision":101,"type":26,"message":{"id":"1","to":"u1","from":"u2","text":"x"}}]\r\r');
    await flush();
    expect(s.sink.operations.map((o) => o.revision)).toEqual([101]);
    await s.clock.advance(30_000);
    expect(s.requests()).toBe(2);
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('101');
    s.receiver.stop();
  });

  it('a bare `event: ping` line pair (no data) and a comment line re-arm the watchdog without a frame', async () => {
    const s = setup();
    const stream = new FakeSseStream();
    s.queue(stream, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    await s.clock.advance(20_000);
    stream.write('event: ping\n\n');
    await flush();
    await s.clock.advance(20_000);
    stream.write(': keepalive\n');
    await flush();
    await s.clock.advance(20_000); // 60 s since open: only the line activity kept the stream alive
    expect(s.requests()).toBe(1);
    expect(stream.closed).toBe(false);
    expect(s.sink.operations).toEqual([]);
    await s.clock.advance(10_000); // 30 s without any line
    expect(s.requests()).toBe(1);
    expect(s.receiver.state).toMatchObject({ kind: 'backoff', failures: 1 }); // no dispatched frame: it counts as a failure
    s.receiver.stop();
  });

  it('a connection that delivered events reconnects immediately and resets the attempt count', async () => {
    const s = setup();
    const productive = new FakeSseStream();
    s.server.on(SSE, failing, failing, failing);
    s.queue(productive);
    s.server.on(SSE, failing);
    s.receiver.start('10');
    await flush();
    await s.clock.advance(1000); // failure 1 -> 1 s
    await s.clock.advance(2000); // failure 2 -> 2 s
    await s.clock.advance(4000); // failure 3 -> 4 s; connection 4 is the productive one
    expect(s.requests()).toBe(4);
    productive.write(frame([op(11)]));
    await flush();
    productive.end();
    await flush();
    expect(s.requests()).toBe(5); // immediate: no timer needed
    // that fifth connection failed: the count was reset, so the delay is 1 s again, not 8 s
    expect(s.receiver.state).toMatchObject({ kind: 'backoff', failures: 1, delayMs: 1000 });
    s.receiver.stop();
  });

  it('backs off min(2^n s, 600 s) and stops after 144 consecutive failures, reporting disconnected', async () => {
    const s = setup();
    for (let i = 0; i < SSE_MAX_FAILED_ATTEMPTS; i += 1) s.server.on(SSE, failing);
    s.receiver.start('10');
    await flush();
    const delays: number[] = [];
    for (let guard = 0; guard < 500 && s.receiver.state.kind !== 'disconnected'; guard += 1) {
      const st = s.receiver.state;
      if (st.kind !== 'backoff') {
        await flush();
        continue;
      }
      delays.push(st.delayMs);
      await s.clock.advance(st.delayMs);
    }
    expect(delays).toHaveLength(SSE_MAX_FAILED_ATTEMPTS - 1);
    expect(delays.slice(0, 11)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 600].map((n) => n * 1000));
    expect(new Set(delays.slice(10))).toEqual(new Set([600_000]));
    expect(s.requests()).toBe(SSE_MAX_FAILED_ATTEMPTS);
    expect(s.receiver.state).toMatchObject({ kind: 'disconnected', failures: SSE_MAX_FAILED_ATTEMPTS, authRejected: false });
    expect(s.errors).toHaveLength(SSE_MAX_FAILED_ATTEMPTS);
    await s.clock.advance(10_000_000);
    expect(s.requests()).toBe(SSE_MAX_FAILED_ATTEMPTS); // nothing restarts it automatically
    // a manual reopen revives it
    s.queue(new FakeSseStream());
    s.receiver.reopen('10');
    await flush();
    expect(s.requests()).toBe(SSE_MAX_FAILED_ATTEMPTS + 1);
    expect(s.receiver.state.kind).toBe('open');
    s.receiver.stop();
  });

  it.each([401, 403])('HTTP %i is an ordinary failed attempt: it backs off and tries again', async (status) => {
    const s = setup();
    s.server.on(SSE, () => new Response('', { status }));
    s.queue(new FakeSseStream());
    s.receiver.start('10');
    await flush();
    expect(s.receiver.state).toMatchObject({ kind: 'backoff', failures: 1, delayMs: 1000 });
    await s.clock.advance(1000);
    expect(s.requests()).toBe(2);
    expect(s.receiver.state).toMatchObject({ kind: 'open' });
    s.receiver.stop();
  });

  it('a network error is a retryable failure', async () => {
    const s = setup();
    s.server.on(SSE, new Error('ECONNRESET'));
    s.queue(new FakeSseStream());
    s.receiver.start('10');
    await flush();
    expect(s.receiver.state).toMatchObject({ kind: 'backoff', failures: 1 });
    await s.clock.advance(1000);
    expect(s.requests()).toBe(2);
    s.receiver.stop();
  });

  it('without an access token (header auth) it stops instead of retrying', async () => {
    const s = setup();
    s.session.setAccessToken(null);
    s.receiver.start('10');
    await flush();
    expect(s.receiver.state).toMatchObject({ kind: 'disconnected', authRejected: true });
    expect(s.server.requests).toHaveLength(0);
  });
});

describe('reconnect and reopen', () => {
  it('reconnect() reopens a live stream at the same cursor', async () => {
    const s = setup();
    const first = new FakeSseStream();
    s.queue(first, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    first.write(frame([op(11)]));
    await flush();
    expect(s.receiver.reconnect()).toBe(true);
    await flush();
    expect(first.closed).toBe(true);
    expect(s.requests()).toBe(2);
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('11');
    s.receiver.stop();
  });

  it('reconnect() skips the backoff wait but does nothing when idle, stopped or disconnected', async () => {
    const s = setup();
    expect(s.receiver.reconnect()).toBe(false);
    s.server.on(SSE, failing);
    s.queue(new FakeSseStream());
    s.receiver.start('10');
    await flush();
    expect(s.receiver.state.kind).toBe('backoff');
    expect(s.receiver.reconnect()).toBe(true);
    await flush();
    expect(s.requests()).toBe(2);
    s.receiver.stop();
    expect(s.receiver.reconnect()).toBe(false);
  });

  it('reconnects after a token refresh via TokenRefresher.setOnRefreshed, with the new token', async () => {
    const s = setup();
    const first = new FakeSseStream();
    s.queue(first, new FakeSseStream());
    s.session.install({
      token: 'tok',
      qrCert: null,
      e2eeStorage: {
        transport: 'CHROMEOS-3.7.2',
        refreshToken: 'refresh-1',
        tokenIssueTimeEpochSec: 1_700_000_000,
        durationUntilRefreshInSec: 3600,
        expire: 1_700_003_600,
      },
    });
    const refresher = new TokenRefresher({
      state: s.session,
      gateway: s.gateway,
      now: () => 1_700_000_000_000,
      timers: { set: () => 1, clear: () => undefined },
      sleep: async () => undefined,
    });
    refresher.setOnRefreshed(() => void s.receiver.reconnect());
    s.server.on(
      TOKEN_REFRESH,
      ok({
        tokenV3IssueResult: {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          tokenIssueTimeEpochSec: '1700003600',
          durationUntilRefreshInSec: '7200',
        },
      }),
    );
    s.receiver.start('10');
    await flush();
    await refresher.refresh();
    await flush();
    expect(first.closed).toBe(true);
    expect(s.requests()).toBe(2);
    expect(headerOf(s.server.to(SSE)[0]!, 'X-Line-Access')).toBe('tok');
    expect(headerOf(s.server.to(SSE)[1]!, 'X-Line-Access')).toBe('access-2');
    s.receiver.stop();
  });

  it('reopen(rev) rewinds the cursor and starts a new epoch', async () => {
    const s = setup();
    const first = new FakeSseStream();
    s.queue(first, new FakeSseStream());
    s.receiver.start('10');
    await flush();
    first.write(frame([op(20)]));
    await flush();
    s.receiver.reopen('12');
    await flush();
    expect(new URL(s.server.to(SSE)[1]!.url).searchParams.get('localRev')).toBe('12');
    expect(s.sink.epochs).toEqual(['10', '12']);
    s.receiver.stop();
  });

  it('stop() closes the stream and nothing restarts it', async () => {
    const s = setup();
    const first = new FakeSseStream();
    s.queue(first);
    s.receiver.start('10');
    await flush();
    s.receiver.stop();
    await flush();
    expect(first.closed).toBe(true);
    expect(s.receiver.state.kind).toBe('stopped');
    await s.clock.advance(1_000_000);
    expect(s.requests()).toBe(1);
  });
});
