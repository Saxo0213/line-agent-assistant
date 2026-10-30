import { describe, expect, it } from 'vitest';
import {
  ChromeApiError,
  ChromeLoginProtocolError,
  fetchIdentity,
  ChromeTransportError,
  ChromeSessionState,
  PIN_POLL_LST_MS,
  appendQrSecret,
  qrLogin,
  ChromeLoginTimeoutError,
} from '../index.js';
import {
  FakeQrBridge,
  FakeServer,
  GET_PROFILE,
  LOGIN_RESULT,
  QR,
  QR_NOTICE,
  failure,
  headerOf,
  makeGateway,
  ok,
  poll410,
  recordEvents,
} from './auth.testkit.js';

const SID = 'session-xyz';
const CALLBACK = 'https://line.me/R/au/q/abc123?foo=bar';

const REJECT_CERT = () => failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 9 } });

function happyServer(): FakeServer {
  return new FakeServer()
    .on(QR('createSession'), ok({ authSessionId: SID }))
    .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK, longPollingIntervalSec: 10, longPollingMaxCount: 3 }))
    .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
    .on(QR('verifyCertificate'), REJECT_CERT())
    .on(QR('createPinCode'), ok({ pinCode: '4821' }))
    .on(QR_NOTICE('checkPinCodeVerified'), ok({}))
    .on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
}

describe('appendQrSecret', () => {
  it('sets secret and e2eeVersion with URLSearchParams.set semantics', () => {
    expect(appendQrSecret(CALLBACK, 'a+b/c=')).toBe('https://line.me/R/au/q/abc123?foo=bar&secret=a%2Bb%2Fc%3D&e2eeVersion=1');
    // existing parameters are replaced in place, not duplicated
    expect(appendQrSecret('https://line.me/R/au/q/x?secret=old&k=v&e2eeVersion=9', 'n')).toBe(
      'https://line.me/R/au/q/x?secret=n&k=v&e2eeVersion=1',
    );
  });
});

describe('qrLogin', () => {
  it('runs the full PIN path with exact bodies and headers, and adopts the result', async () => {
    const server = happyServer();
    const state = new ChromeSessionState();
    const events = recordEvents(state);
    const bridge = new FakeQrBridge();
    const { gateway, signer } = makeGateway(server, state);

    const result = await qrLogin({ gateway, bridge, state });

    expect(server.requests.map((r) => r.path)).toEqual([
      QR('createSession'),
      QR('createQrCode'),
      QR_NOTICE('checkQrCodeVerified'),
      QR('verifyCertificate'),
      QR('createPinCode'),
      QR_NOTICE('checkPinCodeVerified'),
      QR('qrCodeLoginV2'),
    ]);
    const [create, qrCode, scan, , pinCreate, pinCheck, loginV2] = server.requests;
    expect(create!.body).toBe('[{}]');
    expect(qrCode!.body).toBe(`[{"authSessionId":"${SID}"}]`);
    expect(scan!.body).toBe(`[{"authSessionId":"${SID}"}]`);
    expect(pinCreate!.body).toBe(`[{"authSessionId":"${SID}"}]`);
    expect(pinCheck!.body).toBe(`[{"authSessionId":"${SID}"}]`);
    expect(loginV2!.body).toBe(
      `[{"systemName":"CHROMEOS","modelName":"CHROME","autoLoginIsRequired":false,"authSessionId":"${SID}"}]`,
    );

    // session id header + X-LST after X-Hmac: scan = interval*1000, PIN = fixed 110000
    expect(headerOf(scan!, 'X-Line-Session-ID')).toBe(SID);
    expect(headerOf(scan!, 'X-LST')).toBe('10000');
    expect(headerOf(pinCheck!, 'X-Line-Session-ID')).toBe(SID);
    expect(headerOf(pinCheck!, 'X-LST')).toBe(String(PIN_POLL_LST_MS));
    expect(PIN_POLL_LST_MS).toBe(110000);
    expect(scan!.headers.map(([n]) => n).slice(-3)).toEqual(['X-Hmac', 'X-Line-Session-ID', 'X-LST']);
    expect(headerOf(create!, 'X-LST')).toBeUndefined();

    // requireAuth=false everywhere: no X-Line-Access, never an X-Line-Application, signed with the empty token
    for (const r of server.requests) {
      expect(headerOf(r, 'X-Line-Access')).toBeUndefined();
      expect(headerOf(r, 'X-Line-Application')).toBeUndefined();
    }
    expect(signer.calls.every((c) => c.accessToken === '')).toBe(true);

    expect(result.skippedPin).toBe(false);
    expect(result.mid).toBe(LOGIN_RESULT.mid);
    expect(result.certificate).toBe('cert-1');
    expect(result.e2ee?.exported).toEqual({ mid: LOGIN_RESULT.mid, latestKeyId: 2000, keys: { '1000': 'blob-101', '2000': 'blob-102' } });
    expect(result.e2ee?.handles).toEqual({ '1000': 101, '2000': 102 });

    // events: qr (with secret), pin, then qrCert, storage, token
    expect(events.map((e) => e.event)).toEqual(['qr', 'pin', 'qrCert', 'storage', 'token']);
    expect(events[0]!.value).toBe('https://line.me/R/au/q/abc123?foo=bar&secret=cHVi%2B%2Fa2V5PQ%3D%3D&e2eeVersion=1');
    expect(events[1]!.value).toBe('4821');
    expect(events[2]!.value).toBe('cert-1');
    expect(events[4]!.value).toBe('access-1');
    const snapshot = events[3]!.value as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      transport: 'CHROMEOS-3.7.2',
      refreshToken: 'refresh-1',
      tokenIssueTimeEpochSec: 1700000000,
      durationUntilRefreshInSec: 3600,
      expire: 1700003600,
      mid: LOGIN_RESULT.mid,
    });
    expect(state.accessToken).toBe('access-1');
    expect(state.certificate).toBe('cert-1');

    // bridge: keypair first, then the channel/unwrap with the server key from metaData
    expect(bridge.calls).toEqual([
      'curveKeyGenerate',
      'e2eePublicKey:7',
      'e2eeCreateChannel:7:c2VydmVy',
      'e2eeUnwrapKeychain:70:Y2hhaW4=',
      'e2eeGetKeyId:101',
      'e2eeExportKey:101',
      'e2eeGetKeyId:102',
      'e2eeExportKey:102',
    ]);
  });

  it('skips the PIN when verifyCertificate succeeds', async () => {
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK }))
      .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
      .on(QR('verifyCertificate'), ok({}))
      .on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
    const state = new ChromeSessionState();
    state.install({ token: null, qrCert: 'stored-cert', e2eeStorage: null });
    const events = recordEvents(state);
    const { gateway } = makeGateway(server, state);

    const result = await qrLogin({ gateway, bridge: new FakeQrBridge(), state });

    expect(result.skippedPin).toBe(true);
    expect(server.to(QR('createPinCode'))).toHaveLength(0);
    expect(server.to(QR_NOTICE('checkPinCodeVerified'))).toHaveLength(0);
    expect(server.to(QR('verifyCertificate'))[0]!.body).toBe(`[{"authSessionId":"${SID}","certificate":"stored-cert"}]`);
    // defaults: interval 10 s, max count 12 come from OkLine when the server omits them
    expect(headerOf(server.to(QR_NOTICE('checkQrCodeVerified'))[0]!, 'X-LST')).toBe('10000');
    expect(events.map((e) => e.event)).toEqual(['qr', 'qrCert', 'storage', 'token']);
  });

  it('falls back to the PIN when verifyCertificate fails', async () => {
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK }))
      .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
      .on(QR('verifyCertificate'), failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 9 } }))
      .on(QR('createPinCode'), ok({ pinCode: '1111' }))
      .on(QR_NOTICE('checkPinCodeVerified'), ok({}))
      .on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
    const state = new ChromeSessionState();
    const events = recordEvents(state);
    const { gateway } = makeGateway(server, state);

    const result = await qrLogin({ gateway, bridge: new FakeQrBridge(), state, certificate: 'bad-cert' });

    expect(result.skippedPin).toBe(false);
    expect(server.to(QR('verifyCertificate'))).toHaveLength(1);
    expect(events.map((e) => e.event)).toContain('pin');
  });

  it('sends verifyCertificate with an empty certificate when none is stored', async () => {
    const server = happyServer();
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(server, state);
    await qrLogin({ gateway, bridge: new FakeQrBridge(), state });
    expect(server.to(QR('verifyCertificate'))).toHaveLength(1);
    expect(server.to(QR('verifyCertificate'))[0]!.body).toBe(`[{"authSessionId":"${SID}","certificate":""}]`);
  });

  it('throws a transport error from verifyCertificate and does not start the PIN', async () => {
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK }))
      .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
      .on(QR('verifyCertificate'), new Error('socket closed'));
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(server, state);
    await expect(qrLogin({ gateway, bridge: new FakeQrBridge(), state })).rejects.toBeInstanceOf(ChromeTransportError);
    expect(server.to(QR('createPinCode'))).toHaveLength(0);
  });

  it('retries the scan poll on HTTP 410 only, then succeeds', async () => {
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK, longPollingIntervalSec: 5, longPollingMaxCount: 3 }))
      .on(QR_NOTICE('checkQrCodeVerified'), poll410(), poll410(), ok({}))
      .on(QR('verifyCertificate'), REJECT_CERT())
      .on(QR('createPinCode'), ok({ pinCode: '1' }))
      .on(QR_NOTICE('checkPinCodeVerified'), ok({}))
      .on(QR('qrCodeLoginV2'), ok(LOGIN_RESULT));
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(server, state);
    await qrLogin({ gateway, bridge: new FakeQrBridge(), state });
    const scans = server.to(QR_NOTICE('checkQrCodeVerified'));
    expect(scans).toHaveLength(3);
    expect(scans.every((r) => headerOf(r, 'X-LST') === '5000')).toBe(true);
  });

  it('fails after longPollingMaxCount consecutive 410s and sends nothing further', async () => {
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK, longPollingIntervalSec: 10, longPollingMaxCount: 3 }))
      .on(QR_NOTICE('checkQrCodeVerified'), poll410(), poll410(), poll410(), ok({}));
    const state = new ChromeSessionState();
    const events = recordEvents(state);
    const { gateway } = makeGateway(server, state);
    const error = await qrLogin({ gateway, bridge: new FakeQrBridge(), state }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChromeLoginTimeoutError);
    expect((error as ChromeLoginTimeoutError).stage).toBe('qr');
    expect(server.to(QR_NOTICE('checkQrCodeVerified'))).toHaveLength(3);
    expect(server.to(QR('createPinCode'))).toHaveLength(0);
    expect(events.map((e) => e.event)).toEqual(['qr']);
    expect(state.accessToken).toBeNull();
  });

  it('does not retry the scan poll on other errors', async () => {
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK, longPollingMaxCount: 5 }))
      .on(QR_NOTICE('checkQrCodeVerified'), failure(500, { code: 99999, message: 'UNKNOWN' }), ok({}));
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(server, state);
    await expect(qrLogin({ gateway, bridge: new FakeQrBridge(), state })).rejects.toBeInstanceOf(ChromeApiError);
    expect(server.to(QR_NOTICE('checkQrCodeVerified'))).toHaveLength(1);
  });

  it('adopts the outer authToken, not the outer accessToken, from qrCodeLoginV2 (OkLine auth.py:242-245)', async () => {
    const custom = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK }))
      .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
      .on(QR('verifyCertificate'), ok({}))
      .on(QR('qrCodeLoginV2'), ok({ accessToken: 'A', authToken: 'B', mid: LOGIN_RESULT.mid, certificate: 'cert-1' }))
      .on(GET_PROFILE, ok({ mid: LOGIN_RESULT.mid }));
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(custom, state);
    await qrLogin({ gateway, bridge: new FakeQrBridge(), state });
    expect(state.accessToken).toBe('B');
    await fetchIdentity(gateway, state);
    expect(headerOf(custom.to(GET_PROFILE)[0]!, 'X-Line-Access')).toBe('B');
  });

  it('fails when qrCodeLoginV2 returns only an outer accessToken, and sends no getProfile', async () => {
    const custom = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK }))
      .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
      .on(QR('verifyCertificate'), ok({}))
      .on(QR('qrCodeLoginV2'), ok({ accessToken: 'A' }));
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(custom, state);
    const error = await qrLogin({ gateway, bridge: new FakeQrBridge(), state }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChromeLoginProtocolError);
    expect((error as Error).message).toBe('qrCodeLoginV2 returned no access token');
    expect(custom.to(GET_PROFILE)).toHaveLength(0);
    expect(state.accessToken).toBeNull();
  });

  it('keeps the login when the keychain unwrap fails', async () => {
    const server = happyServer();
    const state = new ChromeSessionState();
    const bridge = new FakeQrBridge();
    bridge.failUnwrap = true;
    const { gateway } = makeGateway(server, state);
    const result = await qrLogin({ gateway, bridge, state });
    expect(result.e2ee).toBeNull();
    expect(result.e2eeError).toBe('unwrap failed');
    expect(state.accessToken).toBe('access-1');
    expect(state.e2eeKeys).toBeNull();
  });
});

describe('qrCodeLoginV2 with a text/plain body and a leading space (OkLine transport.py:735-742)', () => {
  it('is not parsed: qrLogin rejects with ChromeApiError, no getProfile, no token', async () => {
    const body = ' {"message":"OK","data":{"accessToken":"a"}}';
    const server = new FakeServer()
      .on(QR('createSession'), ok({ authSessionId: SID }))
      .on(QR('createQrCode'), ok({ callbackUrl: CALLBACK, longPollingIntervalSec: 10, longPollingMaxCount: 3 }))
      .on(QR_NOTICE('checkQrCodeVerified'), ok({}))
      .on(QR('verifyCertificate'), REJECT_CERT())
      .on(QR('createPinCode'), ok({ pinCode: '4821' }))
      .on(QR_NOTICE('checkPinCodeVerified'), ok({}))
      .on(QR('qrCodeLoginV2'), new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const state = new ChromeSessionState();
    const { gateway } = makeGateway(server, state);
    await expect(qrLogin({ gateway, bridge: new FakeQrBridge(), state })).rejects.toBeInstanceOf(ChromeApiError);
    expect(server.to(GET_PROFILE)).toHaveLength(0);
    expect(state.accessToken).toBeNull();
  });
});
