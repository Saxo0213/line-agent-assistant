import { describe, expect, it, vi } from 'vitest';
import {
  CHROME_EXTENSION_VERSION,
  CHROME_USER_AGENT,
  ChromeApiError,
  ChromeAuthKickoutError,
  ChromeConfigError,
  ChromeGateway,
  ChromeInvalidHmacError,
  ChromeLoginRequiredError,
  ChromeMustRefreshTokenError,
  ChromeMustUpgradeError,
  ChromeRefreshKickoutError,
  ChromeRefreshRetryError,
  ChromeRetryableApiError,
  ChromeTransportError,
  FakeHmacSigner,
  isSessionKickout,
  encodeQuery,
  type FetchLike,
  type GatewayOptions,
  type PhysicalRequest,
} from './index.js';

interface Recorded {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | undefined;
}

type Reply = Response | Error | (() => Response | Promise<Response>);

function ok(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ message: 'OK', data }), { status: 200, ...init });
}
function raw(body: string, status = 200): Response {
  return new Response(body, { status });
}
function failure(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function harness(replies: Reply[], extra: Partial<GatewayOptions> = {}) {
  const requests: Recorded[] = [];
  const queue = [...replies];
  const fetchFake: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers as Array<[string, string]>).map(([n, v]) => [n, v]),
      body: init.body as string | undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  const signer = new FakeHmacSigner();
  let token: string | undefined = 'tok-1';
  const gateway = new ChromeGateway({
    fetch: fetchFake,
    signer,
    getAccessToken: () => token,
    ...extra,
  });
  return {
    gateway,
    requests,
    signer,
    setToken: (t: string | undefined) => {
      token = t;
    },
  };
}

const PROFILE = 'Talk.TalkService.getProfile' as const;
const PROFILE_PATH = '/api/talk/thrift/Talk/TalkService/getProfile';

describe('ChromeGateway headers and signing', () => {
  it('sends POST headers in the exact OkLine order with the exact values', async () => {
    const h = harness([ok({ mid: 'u1' })]);
    await h.gateway.call(PROFILE, [2], { mode: 'read' });
    const [req] = h.requests;
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe(`https://line-chrome-gw.line-apps.com${PROFILE_PATH}`);
    expect(req!.headers).toEqual([
      ['accept', 'application/json, text/plain, */*'],
      ['X-Line-Chrome-Version', '3.7.2'],
      ['Accept-Language', 'en-US'],
      ['User-Agent', CHROME_USER_AGENT],
      ['X-LAL', 'en_US'],
      ['X-Line-Access', 'tok-1'],
      ['content-type', 'application/json'],
      ['X-Hmac', expect.stringMatching(/^fake-hmac:/)],
    ]);
    expect(CHROME_EXTENSION_VERSION).toBe('3.7.2');
    expect(CHROME_USER_AGENT).toBe(
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
  });

  it('signs path + compact body for POST and sends the same bytes', async () => {
    const h = harness([ok(null)]);
    const args = [{ chatMids: ['c1'], withMembers: true }, 4, 'é "q"', null];
    await h.gateway.call('Talk.TalkService.getChats', args, { mode: 'read' });
    const compact = '[{"chatMids":["c1"],"withMembers":true},4,"é \\"q\\"",null]';
    expect(h.requests[0]!.body).toBe(compact);
    expect(h.signer.calls).toEqual([
      { accessToken: 'tok-1', pathWithQuery: '/api/talk/thrift/Talk/TalkService/getChats', body: compact },
    ]);
    const hmac = h.requests[0]!.headers.find(([n]) => n === 'X-Hmac')![1];
    expect(hmac).toBe(h.signer.calls[0] && (await new FakeHmacSigner().sign('tok-1', h.signer.calls[0].pathWithQuery, compact)));
  });

  it('sends [] for no arguments', async () => {
    const h = harness([ok('t')]);
    await h.gateway.call('Talk.TalkService.getLastOpRevision', [], { mode: 'read' });
    expect(h.requests[0]!.body).toBe('[]');
    expect(h.signer.calls[0]!.body).toBe('[]');
  });

  it('builds GET with no content-type, signs path?query with an empty body, query order preserved', async () => {
    const h = harness([new Response('', { status: 200 })]);
    const response = await h.gateway.get(
      '/api/operation/receive',
      [
        ['version', '3.7.2'],
        ['language', 'en_US'],
        ['lastPartialFullSyncs', '{}'],
        ['localRev', 12345],
      ],
    );
    expect(response.status).toBe(200);
    const [req] = h.requests;
    const query = 'version=3.7.2&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=12345';
    expect(req!.method).toBe('GET');
    expect(req!.url).toBe(`https://line-chrome-gw.line-apps.com/api/operation/receive?${query}`);
    expect(req!.body).toBeUndefined();
    expect(req!.headers.map(([n]) => n)).toEqual([
      'accept',
      'X-Line-Chrome-Version',
      'Accept-Language',
      'User-Agent',
      'X-LAL',
      'X-Line-Access',
      'X-Hmac',
    ]);
    expect(h.signer.calls).toEqual([{ accessToken: 'tok-1', pathWithQuery: `/api/operation/receive?${query}`, body: '' }]);
  });

  it('encodeQuery matches Python urlencode', () => {
    expect(encodeQuery({ a: 'x y', b: "a'b*c!", c: 'é', d: '~-_.' })).toBe('a=x+y&b=a%27b%2Ac%21&c=%C3%A9&d=~-_.');
  });

  it('inserts X-Legy-Host after X-LAL and X-Line-ChannelToken only for /api/timeline/*', async () => {
    const h = harness([ok(1), ok(2)], { legyHost: 'legy.example', getChannelToken: () => 'chan' });
    await h.gateway.postJson('/api/timeline/getCover', [], { mode: 'read' });
    await h.gateway.call(PROFILE, [2], { mode: 'read' });
    expect(h.requests[0]!.headers.map(([n]) => n)).toEqual([
      'accept',
      'X-Line-Chrome-Version',
      'Accept-Language',
      'User-Agent',
      'X-LAL',
      'X-Legy-Host',
      'X-Line-Access',
      'X-Line-ChannelToken',
      'content-type',
      'X-Hmac',
    ]);
    expect(h.requests[1]!.headers.map(([n]) => n)).not.toContain('X-Line-ChannelToken');
  });

  it('appends per-call extra headers after X-Hmac, and omits X-Line-Access when requireAuth is false', async () => {
    const h = harness([ok({ ok: 1 })]);
    h.setToken(undefined);
    await h.gateway.call(
      'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkQrCodeVerified',
      [{ authSessionId: 'sid' }],
      { mode: 'read', requireAuth: false, extraHeaders: { 'X-Line-Session-ID': 'sid', 'X-LST': '10000' } },
    );
    const names = h.requests[0]!.headers.map(([n]) => n);
    expect(names).toEqual([
      'accept',
      'X-Line-Chrome-Version',
      'Accept-Language',
      'User-Agent',
      'X-LAL',
      'content-type',
      'X-Hmac',
      'X-Line-Session-ID',
      'X-LST',
    ]);
    expect(h.signer.calls[0]!.accessToken).toBe('');
  });

  it('never adds X-Line-Application to gateway calls and refuses it as an extra header', async () => {
    const h = harness([ok(1), new Response('', { status: 200 })]);
    await h.gateway.call(PROFILE, [2], { mode: 'read' });
    await h.gateway.get('/api/operation/receive', [['version', '3.7.2']]);
    for (const req of h.requests) {
      expect(req.headers.map(([n]) => n.toLowerCase())).not.toContain('x-line-application');
    }
    await expect(
      h.gateway.call(PROFILE, [2], { mode: 'read', extraHeaders: { 'x-line-application': 'CHROMEOS\t3.7.2\tChrome_OS\t' } }),
    ).rejects.toBeInstanceOf(ChromeConfigError);
    expect(h.requests).toHaveLength(2);
  });

  it('throws ChromeLoginRequiredError without a token and sends nothing', async () => {
    const h = harness([]);
    h.setToken('');
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).rejects.toBeInstanceOf(ChromeLoginRequiredError);
    expect(h.requests).toHaveLength(0);
  });

  it('runs beforeRequest for every physical attempt with the wire headers, and a throw blocks the request', async () => {
    const seen: PhysicalRequest[] = [];
    const h = harness([failure(500, {}), ok(1)], { beforeRequest: (r) => void seen.push(r) });
    await h.gateway.call(PROFILE, [2], { mode: 'read' });
    expect(seen.map((r) => [r.attempt, r.replay, r.mode, r.endpointKey])).toEqual([
      [0, false, 'read', PROFILE],
      [1, false, 'read', PROFILE],
    ]);
    expect(seen[0]!.headers).toEqual(h.requests[0]!.headers);

    const blocked = harness([ok(1)], {
      beforeRequest: () => {
        throw new Error('gate says no');
      },
    });
    await expect(blocked.gateway.call(PROFILE, [2], { mode: 'write' })).rejects.toThrow('gate says no');
    expect(blocked.requests).toHaveLength(0);
  });
});

describe('ChromeGateway envelope and error classification', () => {
  it('succeeds only on message === "OK" and returns data', async () => {
    const h = harness([ok({ a: 1 })]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toEqual({ a: 1 });
  });

  it.each([
    ['lower-case ok', JSON.stringify({ message: 'ok', data: 1 })],
    ['no envelope', JSON.stringify({ data: 1 })],
    ['array', '[1]'],
    ['not json', 'oops'],
  ])('treats a 200 with %s as an error', async (_name, body) => {
    const h = harness([raw(body)]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'write' })).rejects.toBeInstanceOf(ChromeApiError);
  });

  it('10006 -> ChromeMustUpgradeError, unless ignoreMustUpgrade', async () => {
    const body = { code: 10006, message: 'REQUEST_MUST_UPGRADE' };
    const h = harness([failure(400, body), failure(400, body)]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'write' })).rejects.toBeInstanceOf(ChromeMustUpgradeError);
    const e = await h.gateway.call(PROFILE, [2], { mode: 'write', ignoreMustUpgrade: true }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(ChromeMustUpgradeError);
    expect(e).toBeInstanceOf(ChromeApiError);
  });

  it('10005 -> ChromeInvalidHmacError', async () => {
    const h = harness([failure(400, { code: 10005, message: 'REQUEST_INVALID_HMAC' })]);
    const e = await h.gateway.call(PROFILE, [2], { mode: 'write' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChromeInvalidHmacError);
    expect((e as ChromeInvalidHmacError).outerCode).toBe(10005);
  });

  it('10052 surfaces the nested statusCode as code and status (410 for pin timeout)', async () => {
    const h = harness([
      failure(400, { code: 10052, message: 'RESPONSE_HTTP_ERROR', data: { statusCode: 410, rejectionReason: 'timeout' } }),
    ]);
    const e = (await h.gateway
      .call('LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkQrCodeVerified', [{}], { mode: 'read', requireAuth: false })
      .catch((x: unknown) => x)) as ChromeApiError;
    expect(e).toBeInstanceOf(ChromeApiError);
    expect(e.status).toBe(410);
    expect(e.code).toBe(410);
    expect(e.outerCode).toBe(10052);
    expect(e.metadata).toEqual({ rejectionReason: 'timeout' });
  });

  it('10201 -> ChromeRefreshKickoutError and 10202 -> ChromeRefreshRetryError from tokenRefresh', async () => {
    const h = harness([failure(400, { code: 10201, message: 'AUTH_INVALID_REQUEST' }), failure(400, { code: 10202, message: 'AUTH_RETRY_REQUIRED' })]);
    await expect(h.gateway.postJson('/api/auth/tokenRefresh', { refreshToken: 'r' }, { mode: 'write' })).rejects.toBeInstanceOf(
      ChromeRefreshKickoutError,
    );
    await expect(h.gateway.postJson('/api/auth/tokenRefresh', { refreshToken: 'r' }, { mode: 'write' })).rejects.toBeInstanceOf(
      ChromeRefreshRetryError,
    );
  });

  it('tokenRefresh classifies 10201/10202 from the Python code: the nested TalkException code wins', async () => {
    const h = harness([
      failure(400, { code: 10201, message: 'AUTH_INVALID_REQUEST', data: { name: 'TalkException', code: 5, reason: 'x' } }),
      failure(400, { message: 'FAILED', data: { code: 10201 } }),
      failure(400, { code: 10202, data: { code: 5 } }),
      failure(400, { message: 'FAILED', data: { code: 10202 } }),
      failure(400, { code: 10201, message: 'PLEASE UPGRADE' }),
    ]);
    const post = () => h.gateway.postJson('/api/auth/tokenRefresh', { refreshToken: 'r' }, { mode: 'write' }).catch((x: unknown) => x);
    const plain = (await post()) as ChromeApiError;
    expect(plain).toBeInstanceOf(ChromeApiError);
    expect(plain).not.toBeInstanceOf(ChromeRefreshKickoutError);
    expect(plain.code).toBe(5);
    expect(plain.outerCode).toBe(10201);
    const nestedKick = (await post()) as ChromeApiError;
    expect(nestedKick).toBeInstanceOf(ChromeRefreshKickoutError);
    expect(nestedKick.code).toBe(10201);
    expect(await post()).not.toBeInstanceOf(ChromeRefreshRetryError);
    expect(await post()).toBeInstanceOf(ChromeRefreshRetryError);
    expect(await post()).toBeInstanceOf(ChromeRefreshKickoutError);
  });

  it('10201 and 10202 on a path other than tokenRefresh are a plain ChromeApiError, with no retry', async () => {
    const h = harness([failure(400, { code: 10201, message: 'x' }), failure(400, { code: 10202, message: 'x' })]);
    const a = (await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeApiError;
    expect(a).toBeInstanceOf(ChromeApiError);
    expect(a).not.toBeInstanceOf(ChromeRefreshKickoutError);
    expect(a.outerCode).toBe(10201);
    expect(isSessionKickout(a)).toBe(false);
    const b = await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x);
    expect(b).not.toBeInstanceOf(ChromeRefreshRetryError);
    expect(b).toBeInstanceOf(ChromeApiError);
    expect(h.requests).toHaveLength(2);
  });

  it.each([1, 7, 8])('inner TalkException %i inside the talk-auth scope -> ChromeAuthKickoutError', async (code) => {
    const h = harness([failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code, reason: 'x' } })]);
    const e = await h.gateway.call(PROFILE, [2], { mode: 'write' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChromeAuthKickoutError);
    expect((e as ChromeAuthKickoutError).innerCode).toBe(code);
  });

  it('inner 1/7/8 outside the talk-auth scope (Chat, ChannelService, ignoreAuthException) is a plain ChromeApiError', async () => {
    const body = { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 8, reason: 'x' } };
    const h = harness([failure(400, body), failure(400, body), failure(400, body)]);
    const chat = await h.gateway.postJson('/api/talk/thrift/Chat/ChatService/foo', [], { mode: 'write' }).catch((x: unknown) => x);
    const channel = await h.gateway.postJson('/api/talk/thrift/Talk/ChannelService/issueChannelToken', [], { mode: 'write' }).catch((x: unknown) => x);
    const ignored = await h.gateway.call(PROFILE, [2], { mode: 'write', ignoreAuthException: true }).catch((x: unknown) => x);
    for (const e of [chat, channel, ignored]) {
      expect(e).toBeInstanceOf(ChromeApiError);
      expect(e).not.toBeInstanceOf(ChromeAuthKickoutError);
    }
  });

  it('HTTP 401 is a kickout', async () => {
    const h = harness([failure(401, {})]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'write' })).rejects.toBeInstanceOf(ChromeAuthKickoutError);
  });

  it('99999 and inner 115 classify as ChromeRetryableApiError', async () => {
    const h = harness([
      failure(200, { code: 99999, message: 'UNKNOWN_ERROR' }),
      failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 115, reason: 'retry' } }),
    ]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'write' })).rejects.toBeInstanceOf(ChromeRetryableApiError);
    const e = await h.gateway.call(PROFILE, [2], { mode: 'write' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChromeRetryableApiError);
    expect((e as ChromeRetryableApiError).innerCode).toBe(115);
  });

  describe('Python int typing and dict.get for error codes (OkLine transport.py:864, :876-878)', () => {
    it('data.code true on getProfile is code 1: ChromeAuthKickoutError with code and innerCode 1', async () => {
      const h = harness([failure(200, { message: 'FAILED', data: { code: true } })]);
      const e = (await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeAuthKickoutError;
      expect(e).toBeInstanceOf(ChromeAuthKickoutError);
      expect(e.code).toBe(1);
      expect(e.innerCode).toBe(1);
    });
    it('data.code true on addFriendByMid is a plain ChromeApiError with code 1', async () => {
      const h = harness([failure(200, { message: 'FAILED', data: { code: true } })]);
      const e = (await h.gateway
        .call('Relation.RelationService.addFriendByMid', [], { mode: 'write' })
        .catch((x: unknown) => x)) as ChromeApiError;
      expect(e).toBeInstanceOf(ChromeApiError);
      expect(e).not.toBeInstanceOf(ChromeAuthKickoutError);
      expect(e.code).toBe(1);
    });
    it('data.code false on getProfile is code 0 and no kickout', async () => {
      const h = harness([failure(200, { message: 'FAILED', data: { code: false } })]);
      const e = (await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeApiError;
      expect(e).toBeInstanceOf(ChromeApiError);
      expect(e).not.toBeInstanceOf(ChromeAuthKickoutError);
      expect(e.code).toBe(0);
    });
    it('error.code null hides error.statusCode: code is undefined and no kickout', async () => {
      const h = harness([failure(400, { error: { code: null, statusCode: 1 } })]);
      const e = (await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeApiError;
      expect(e).toBeInstanceOf(ChromeApiError);
      expect(e).not.toBeInstanceOf(ChromeAuthKickoutError);
      expect(e.code).toBeUndefined();
    });
    it('error.statusCode alone (no code key) still gives code 1 and a kickout', async () => {
      const h = harness([failure(400, { error: { statusCode: 1 } })]);
      const e = (await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeApiError;
      expect(e).toBeInstanceOf(ChromeAuthKickoutError);
      expect(e.code).toBe(1);
    });
    it('outer code true gives outerCode 1, a plain ChromeApiError and no retry', async () => {
      const h = harness([failure(400, { code: true, message: 'X' })]);
      const e = (await h.gateway.call(PROFILE, [2], { mode: 'write' }).catch((x: unknown) => x)) as ChromeApiError;
      expect(e).toBeInstanceOf(ChromeApiError);
      expect(e).not.toBeInstanceOf(ChromeRetryableApiError);
      expect(e.outerCode).toBe(1);
      expect(h.requests).toHaveLength(1);
    });
  });

  describe('error body uses Python truthiness (OkLine transport.py:864-885, K1)', () => {
    const fail = async (body: unknown) => {
      const h = harness([failure(400, body)]);
      return (await h.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeApiError;
    };
    it('an empty error.metadata array falls through to parameterMap', async () => {
      const e = await fail({ error: { code: 3, message: 'x', metadata: [], parameterMap: { k: 'v' } } });
      expect(e.metadata).toEqual({ k: 'v' });
      expect(e.code).toBe(3);
    });
    it('an empty nested parameterMap array falls through to nested metadata', async () => {
      const e = await fail({ code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 5, reason: 'r', parameterMap: [], metadata: { a: 1 } } });
      expect(e.metadata).toEqual({ a: 1 });
      expect(e.code).toBe(5);
    });
    it('a nested block with an empty reason array and a null code is skipped', async () => {
      const e = await fail({ code: 10051, message: 'RESPONSE_ERROR', data: { reason: [], code: null, alertMessage: 'A', parameterMap: { p: 1 } } });
      // The body has no `error` key, so the outer block is the error block: its code 10051 stays; the nested code is not read.
      expect(e.code).toBe(10051);
      expect(e.reason).toBe('RESPONSE_ERROR');
      expect(e.message).toBe('RESPONSE_ERROR');
      expect(e.metadata).toBeUndefined();
    });
    it('an empty metadata object still falls through to parameterMap (control)', async () => {
      const e = await fail({ error: { code: 3, metadata: {}, parameterMap: { k: 'v' } } });
      expect(e.metadata).toEqual({ k: 'v' });
    });
  });

  it('surfaces the inner TalkException code and reason for ordinary errors', async () => {
    const h = harness([failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 82, reason: 'plain mode' } })]);
    const e = (await h.gateway.call(PROFILE, [2], { mode: 'write' }).catch((x: unknown) => x)) as ChromeApiError;
    expect(e.code).toBe(82);
    expect(e.reason).toBe('plain mode');
    expect(e.message).toBe('plain mode');
  });
});

describe('ChromeGateway retry policy', () => {
  const retryable = () => failure(200, { code: 99999, message: 'UNKNOWN_ERROR' });
  const inner115 = () => failure(400, { code: 10051, message: 'x', data: { name: 'TalkException', code: 115, reason: 'retry' } });

  it('reads retry up to 2 times on 5xx, 99999 and inner 115, then succeed', async () => {
    const h = harness([failure(503, {}), retryable(), ok('done')]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toBe('done');
    expect(h.requests).toHaveLength(3);
    const h2 = harness([inner115(), inner115(), ok('done')]);
    await expect(h2.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toBe('done');
    expect(h2.requests).toHaveLength(3);
  });

  it('reads give up after 3 attempts total', async () => {
    const h = harness([retryable(), retryable(), retryable(), ok('never')]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).rejects.toBeInstanceOf(ChromeRetryableApiError);
    expect(h.requests).toHaveLength(3);
    const h5 = harness([failure(500, {}), failure(502, {}), failure(503, {})]);
    const e = (await h5.gateway.call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeApiError;
    expect(e).toBeInstanceOf(ChromeApiError);
    expect(e.status).toBe(503);
    expect(h5.requests).toHaveLength(3);
  });

  it('reads retry network errors; retries reuse the same signed bytes', async () => {
    const h = harness([new TypeError('fetch failed'), ok('done')]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toBe('done');
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.headers).toEqual(h.requests[0]!.headers);
    expect(h.signer.calls).toHaveLength(1);
  });

  it('honours retryDelayMs through the injected sleep', async () => {
    const sleep = vi.fn(async () => undefined);
    const h = harness([retryable(), ok(1)], { retryDelayMs: 250, sleep });
    await h.gateway.call(PROFILE, [2], { mode: 'read' });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
  });

  it.each([
    ['5xx', () => failure(503, {})],
    ['99999', retryable],
    ['inner 115', inner115],
  ])('writes never retry on %s', async (_name, make) => {
    const h = harness([make(), ok('never')]);
    await expect(h.gateway.call('Talk.TalkService.sendMessage', [1, {}], { mode: 'write' })).rejects.toBeInstanceOf(ChromeApiError);
    expect(h.requests).toHaveLength(1);
  });

  it('writes never retry a network error and report an unknown outcome', async () => {
    const h = harness([new TypeError('fetch failed'), ok('never')]);
    const e = await h.gateway.call('Talk.TalkService.sendMessage', [1, {}], { mode: 'write' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChromeTransportError);
    expect((e as ChromeTransportError).outcomeUnknown).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it('times out a hung request (read failure is not an unknown outcome, write is)', async () => {
    const hang = (): Promise<Response> => new Promise(() => undefined);
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        void hang;
      });
    const gw = (maxReadRetries: number) =>
      new ChromeGateway({ fetch: hangingFetch, signer: new FakeHmacSigner(), getAccessToken: () => 't', timeoutMs: 20, maxReadRetries });
    const read = (await gw(0).call(PROFILE, [2], { mode: 'read' }).catch((x: unknown) => x)) as ChromeTransportError;
    expect(read).toBeInstanceOf(ChromeTransportError);
    expect(read.timedOut).toBe(true);
    expect(read.outcomeUnknown).toBe(false);
    const write = (await gw(0).call('Talk.TalkService.sendMessage', [1, {}], { mode: 'write' }).catch((x: unknown) => x)) as ChromeTransportError;
    expect(write.timedOut).toBe(true);
    expect(write.outcomeUnknown).toBe(true);
  });

  it('a per-call timeout overrides the default', async () => {
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    const gw = new ChromeGateway({ fetch: hangingFetch, signer: new FakeHmacSigner(), getAccessToken: () => 't', timeoutMs: 60_000 });
    const e = await gw.call(PROFILE, [2], { mode: 'write', timeoutMs: 10 }).catch((x: unknown) => x);
    expect((e as ChromeTransportError).timedOut).toBe(true);
  });
});

describe('ChromeGateway inner 119 refresh', () => {
  const must119 = () => failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 119, reason: 'refresh' } });

  it('refreshes via onMustRefresh then replays once with the new token and a fresh signature (reads)', async () => {
    let token = 'old';
    const onMustRefresh = vi.fn(async () => {
      token = 'new';
      return true;
    });
    const requests: Recorded[] = [];
    const queue: Response[] = [must119(), ok('fresh')];
    const signer = new FakeHmacSigner();
    const gateway = new ChromeGateway({
      fetch: async (url, init) => {
        requests.push({ url, method: init.method!, headers: init.headers as Array<[string, string]>, body: init.body as string });
        return queue.shift()!;
      },
      signer,
      getAccessToken: () => token,
      onMustRefresh,
    });
    await expect(gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toBe('fresh');
    expect(onMustRefresh).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.find(([n]) => n === 'X-Line-Access')![1]).toBe('old');
    expect(requests[1]!.headers.find(([n]) => n === 'X-Line-Access')![1]).toBe('new');
    expect(signer.calls.map((c) => c.accessToken)).toEqual(['old', 'new']);
  });

  it('marks the replay in beforeRequest', async () => {
    const seen: PhysicalRequest[] = [];
    const h = harness([must119(), ok(1)], { onMustRefresh: async () => true, beforeRequest: (r) => void seen.push(r) });
    await h.gateway.call(PROFILE, [2], { mode: 'read' });
    expect(seen.map((r) => r.replay)).toEqual([false, true]);
  });

  it('replays only once: a second 119 surfaces ChromeMustRefreshTokenError', async () => {
    const onMustRefresh = vi.fn(async () => true);
    const h = harness([must119(), must119(), ok('never')], { onMustRefresh });
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).rejects.toBeInstanceOf(ChromeMustRefreshTokenError);
    expect(onMustRefresh).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(2);
  });

  it('surfaces 119 when no hook is wired, when the hook returns false and when it throws', async () => {
    const none = harness([must119()]);
    await expect(none.gateway.call(PROFILE, [2], { mode: 'read' })).rejects.toBeInstanceOf(ChromeMustRefreshTokenError);
    const no = harness([must119()], { onMustRefresh: async () => false });
    await expect(no.gateway.call(PROFILE, [2], { mode: 'read' })).rejects.toBeInstanceOf(ChromeMustRefreshTokenError);
    const boom = harness([must119()], {
      onMustRefresh: async () => {
        throw new Error('refresh failed');
      },
    });
    await expect(boom.gateway.call(PROFILE, [2], { mode: 'read' })).rejects.toBeInstanceOf(ChromeMustRefreshTokenError);
  });

  it('writes refresh the token but never replay: the 119 is surfaced after one hook call', async () => {
    const onMustRefresh = vi.fn(async () => true);
    const h = harness([must119(), ok('never')], { onMustRefresh });
    await expect(h.gateway.call('Talk.TalkService.sendMessage', [1, {}], { mode: 'write' })).rejects.toBeInstanceOf(
      ChromeMustRefreshTokenError,
    );
    expect(onMustRefresh).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(1);
  });

  it('a write with a failing hook still surfaces the 119', async () => {
    const h = harness([must119()], { onMustRefresh: async () => { throw new Error('refresh failed'); } });
    await expect(h.gateway.call('Talk.TalkService.sendMessage', [1, {}], { mode: 'write' })).rejects.toBeInstanceOf(ChromeMustRefreshTokenError);
  });

  it('passes redirect: error to fetch for POST and GET', async () => {
    const inits: RequestInit[] = [];
    const gateway = new ChromeGateway({
      fetch: async (_url, init) => { inits.push(init); return ok(1); },
      signer: new FakeHmacSigner(), getAccessToken: () => 'tok',
    });
    await gateway.call(PROFILE, [2], { mode: 'read' });
    await gateway.get('/api/operation/receive', undefined);
    expect(inits.map((init) => init.redirect)).toEqual(['error', 'error']);
  });

  it('a redirect rejection is a transport error: a read retries, a write is unknown', async () => {
    let reads = 0;
    const read = new ChromeGateway({
      fetch: async () => { reads += 1; if (reads === 1) throw new TypeError('redirect mode is set to error'); return ok('after'); },
      signer: new FakeHmacSigner(), getAccessToken: () => 'tok',
    });
    await expect(read.call(PROFILE, [2], { mode: 'read' })).resolves.toBe('after');
    const write = new ChromeGateway({
      fetch: async () => { throw new TypeError('redirect mode is set to error'); },
      signer: new FakeHmacSigner(), getAccessToken: () => 'tok',
    });
    const error = await write.call('Talk.TalkService.sendMessage', [1, {}], { mode: 'write' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChromeTransportError);
    expect((error as ChromeTransportError).outcomeUnknown).toBe(true);
  });

  it('does not treat 119 outside the talk-auth scope as a refresh trigger', async () => {
    const onMustRefresh = vi.fn(async () => true);
    const h = harness([must119()], { onMustRefresh });
    const e = await h.gateway.postJson('/api/talk/thrift/Chat/ChatService/x', [], { mode: 'read' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChromeApiError);
    expect(e).not.toBeInstanceOf(ChromeMustRefreshTokenError);
    expect(onMustRefresh).not.toHaveBeenCalled();
  });
});

describe('ChromeGateway large integers', () => {
  it('keeps ids and revisions beyond 2^53 as exact decimal strings and small numbers as numbers', async () => {
    const body =
      '{"message":"OK","data":{"revision":9007199254740993,"messageId":-123456789012345678901,"nested":[{"id":1234567890123456789}],"count":42,"ratio":1.5,"exp":1e3,"text":"9007199254740993"}}';
    const h = harness([raw(body)]);
    const data = await h.gateway.call<Record<string, unknown>>(PROFILE, [2], { mode: 'read' });
    expect(data).toEqual({
      revision: '9007199254740993',
      messageId: '-123456789012345678901',
      nested: [{ id: '1234567890123456789' }],
      count: 42,
      ratio: 1.5,
      exp: 1000,
      text: '9007199254740993',
    });
  });

  it('sends string ids back verbatim in the request body', async () => {
    const h = harness([ok(null)]);
    await h.gateway.call('Talk.TalkService.unsendMessage', [7, '9007199254740993'], { mode: 'write' });
    expect(h.requests[0]!.body).toBe('[7,"9007199254740993"]');
  });
});

describe('ChromeGateway content-type rule (OkLine transport.py:735-742)', () => {
  const LEADING = ' {"message":"OK","data":{"value":1}}';
  const withType = (body: string, status: number, type: string | null): Response => {
    const headers = new Headers();
    if (type !== null) headers.set('content-type', type);
    return new Response(body, { status, headers });
  };
  const call = (h: ReturnType<typeof harness>, mode: 'read' | 'write' = 'read') =>
    h.gateway.call<unknown>(PROFILE, [2], { mode }).catch((x: unknown) => x) as Promise<ChromeApiError>;

  it('2xx text/plain body with a leading space is not parsed: plain ChromeApiError, one request', async () => {
    const h = harness([withType(LEADING, 200, 'text/plain')]);
    const e = await call(h);
    expect(e).toBeInstanceOf(ChromeApiError);
    expect(e.constructor).toBe(ChromeApiError);
    expect(e.message).toBe(`gateway response without OK envelope for ${PROFILE_PATH}`);
    expect(e.code).toBeUndefined();
    expect(e.raw).toBeUndefined();
    expect(h.requests).toHaveLength(1);
  });

  it('the same body with a json content-type resolves', async () => {
    const h = harness([withType(LEADING, 200, 'application/json; charset=utf-8')]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toEqual({ value: 1 });
  });

  it('the same body without the leading space and with text/plain resolves', async () => {
    const h = harness([withType(LEADING.trimStart(), 200, 'text/plain')]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toEqual({ value: 1 });
  });

  it('400 text/html body with a leading space: plain ChromeApiError, no kickout, one request', async () => {
    const h = harness([withType(' {"error":{"code":1}}', 400, 'text/html')]);
    const e = await call(h);
    expect(e).toBeInstanceOf(ChromeApiError);
    expect(e).not.toBeInstanceOf(ChromeAuthKickoutError);
    expect(e.code).toBeUndefined();
    expect(h.requests).toHaveLength(1);
  });

  it('400 text/html body without the space: ChromeAuthKickoutError with code 1', async () => {
    const h = harness([withType('{"error":{"code":1}}', 400, 'text/html')]);
    const e = await call(h);
    expect(e).toBeInstanceOf(ChromeAuthKickoutError);
    expect(e.code).toBe(1);
  });

  it('500 text/html body: a read makes 3 requests, a write makes 1, both give HTTP 500', async () => {
    const h = harness([
      withType('<html>500</html>', 500, 'text/html'),
      withType('<html>500</html>', 500, 'text/html'),
      withType('<html>500</html>', 500, 'text/html'),
    ]);
    const e = await call(h);
    expect(e.constructor).toBe(ChromeApiError);
    expect(e.message).toBe(`HTTP 500 for ${PROFILE_PATH}`);
    expect(e.code).toBeUndefined();
    expect(e.raw).toBeUndefined();
    expect(h.requests).toHaveLength(3);
    const hw = harness([withType('<html>500</html>', 500, 'text/html')]);
    const ew = await call(hw, 'write');
    expect(ew.message).toBe(`HTTP 500 for ${PROFILE_PATH}`);
    expect(hw.requests).toHaveLength(1);
  });

  it('no content-type header: first character { parses, a leading space does not', async () => {
    const h = harness([withType('{"message":"OK","data":1}', 200, null)]);
    await expect(h.gateway.call(PROFILE, [2], { mode: 'read' })).resolves.toBe(1);
    const h2 = harness([withType(' {"message":"OK","data":1}', 200, null)]);
    const e = await call(h2);
    expect(e.constructor).toBe(ChromeApiError);
    expect(e.message).toBe(`gateway response without OK envelope for ${PROFILE_PATH}`);
    expect(e.raw).toBeUndefined();
  });
});
