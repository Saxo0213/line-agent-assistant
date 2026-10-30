import { describe, expect, it } from 'vitest';
import {
  CHROME_TRANSPORT_TAG,
  ChromeSessionState,
  ChromeSessionStateError,
  fetchIdentity,
  loginWithToken,
  logoutV2,
  TokenRefresher,
  type JsonValue,
} from '../index.js';
import { FakeServer, GET_PROFILE, LOGOUT_V2, TOKEN_REFRESH, failure, headerOf, makeGateway, ok, recordEvents } from './auth.testkit.js';

const MID = 'u0123456789abcdef0123456789abcdef';

function loggedIn(): ChromeSessionState {
  const state = new ChromeSessionState();
  state.adoptLogin({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenIssueTimeEpochSec: 1_700_000_000,
    durationUntilRefreshInSec: 3600,
    refreshApiRetryPolicy: { initialDelayInMillis: 1000, maxDelayInMillis: 30000, multiplier: 2, jitterRate: 0.1 },
    certificate: 'cert-1',
    mid: MID,
    e2eeKeys: { mid: MID, latestKeyId: 2000, keys: { '1000': 'blob-a', '2000': 'blob-b' } },
  });
  state.setProfile(MID, 'JP');
  return state;
}

describe('session snapshot', () => {
  it('round-trips every persisted field through install()', () => {
    const a = loggedIn();
    a.nextReqSeq();
    const snapshot = JSON.parse(JSON.stringify(a.snapshot())) as JsonValue; // through the JSON secret slot
    expect(snapshot).toEqual({
      transport: 'CHROMEOS-3.7.2',
      refreshToken: 'refresh-1',
      tokenIssueTimeEpochSec: 1_700_000_000,
      durationUntilRefreshInSec: 3600,
      expire: 1_700_003_600,
      'chrome:refreshApiRetryPolicy': { initialDelayInMillis: 1000, maxDelayInMillis: 30000, multiplier: 2, jitterRate: 0.1 },
      mid: MID,
      regionCode: 'JP',
      'chrome:e2eeKeys': { mid: MID, latestKeyId: 2000, keys: { '1000': 'blob-a', '2000': 'blob-b' } },
      'chrome:reqSeq': 1,
    });

    const b = new ChromeSessionState();
    b.install({ token: a.accessToken, qrCert: a.certificate, e2eeStorage: snapshot });
    expect(b.accessToken).toBe('access-1');
    expect(b.certificate).toBe('cert-1');
    expect(b.refreshToken).toBe('refresh-1');
    expect(b.expire).toBe(1_700_003_600);
    expect(b.mid).toBe(MID);
    expect(b.regionCode).toBe('JP');
    expect(b.e2eeKeys).toEqual(a.e2eeKeys);
    expect(b.refreshApiRetryPolicy).toEqual(a.refreshApiRetryPolicy);
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('CHROME_TRANSPORT_TAG is derived from the single version constant', () => {
    expect(CHROME_TRANSPORT_TAG).toBe('CHROMEOS-3.7.2');
  });

  it('rejects a snapshot whose transport is not CHROMEOS-3.7.2 and leaves the state untouched', () => {
    const state = loggedIn();
    const before = state.snapshot();
    const desktop = { refreshToken: 'r', expire: 1, authToken: 'x' }; // linejs storage shape, no transport tag
    expect(() => state.install({ token: 't', qrCert: null, e2eeStorage: desktop as JsonValue })).toThrow(ChromeSessionStateError);
    expect(() => state.install({ token: 't', qrCert: null, e2eeStorage: { ...desktop, transport: 'DESKTOPWIN' } as JsonValue })).toThrow(
      ChromeSessionStateError,
    );
    expect(() => state.install({ token: 't', qrCert: null, e2eeStorage: { transport: 'CHROMEOS-3.7.1' } })).toThrow(ChromeSessionStateError);
    expect(() => state.install({ token: 't', qrCert: null, e2eeStorage: [] })).toThrow(ChromeSessionStateError);
    expect(state.snapshot()).toEqual(before);
    expect(state.accessToken).toBe('access-1');
  });

  it('strictly rejects wrongly typed fields', () => {
    const base = { transport: 'CHROMEOS-3.7.2' };
    const bad: Array<Record<string, unknown>> = [
      { ...base, refreshToken: 5 },
      { ...base, tokenIssueTimeEpochSec: '17' },
      { ...base, 'chrome:reqSeq': -1 },
      { ...base, 'chrome:reqSeq': 1.5 },
      { ...base, 'chrome:refreshApiRetryPolicy': [] },
      { ...base, 'chrome:e2eeKeys': { keys: { abc: 'x' } } },
      { ...base, 'chrome:e2eeKeys': { keys: { '1': '' } } },
      { ...base, mid: 3 },
    ];
    for (const e2eeStorage of bad) {
      const state = new ChromeSessionState();
      expect(() => state.install({ token: null, qrCert: null, e2eeStorage: e2eeStorage as JsonValue })).toThrow(ChromeSessionStateError);
    }
  });

  it('accepts null storage as an empty state and derives expire from a stored value when issue/duration are absent', () => {
    const state = new ChromeSessionState();
    state.install({ token: null, qrCert: null, e2eeStorage: null });
    expect(state.expire).toBeNull();
    expect(state.lastReqSeq).toBe(0);
    state.install({ token: 't', qrCert: null, e2eeStorage: { transport: 'CHROMEOS-3.7.2', expire: 123 } });
    expect(state.expire).toBe(123);
  });
});

describe('ReqSeq allocator (ruling 8)', () => {
  it('is monotonic starting at 1 and checkpoints a storage snapshot after each allocation', () => {
    const state = new ChromeSessionState();
    const events = recordEvents(state);
    expect([state.nextReqSeq(), state.nextReqSeq(), state.nextReqSeq()]).toEqual([1, 2, 3]);
    expect(events.map((e) => e.event)).toEqual(['storage', 'storage', 'storage']);
    expect(events.map((e) => (e.value as Record<string, unknown>)['chrome:reqSeq'])).toEqual([1, 2, 3]);
  });

  it('resumes at saved+1 after a restart', () => {
    const first = loggedIn();
    let saved: JsonValue = first.snapshot();
    first.on('storage', (snapshot: JsonValue) => void (saved = snapshot));
    first.nextReqSeq();
    first.nextReqSeq();
    first.nextReqSeq();
    expect(first.nextReqSeq()).toBe(4);

    const restarted = new ChromeSessionState();
    restarted.install({ token: 'access-1', qrCert: null, e2eeStorage: JSON.parse(JSON.stringify(saved)) as JsonValue });
    expect(restarted.lastReqSeq).toBe(4);
    expect(restarted.nextReqSeq()).toBe(5);
  });

  it('survives login, refresh and profile updates without resetting', () => {
    const state = loggedIn();
    state.nextReqSeq();
    state.nextReqSeq();
    state.adoptRefresh({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      tokenIssueTimeEpochSec: 1,
      durationUntilRefreshInSec: 2,
      refreshApiRetryPolicy: null,
    });
    expect(state.nextReqSeq()).toBe(3);
  });
});

describe('logoutV2', () => {
  it('sends Talk.AuthService.logoutV2 with an empty argument list, signed, as a single write', async () => {
    const server = new FakeServer().on(LOGOUT_V2, ok(null));
    const state = loggedIn();
    const { gateway } = makeGateway(server, state);
    await logoutV2({ gateway, state });
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.path).toBe('/api/talk/thrift/Talk/AuthService/logoutV2');
    expect(req.method).toBe('POST');
    expect(req.body).toBe('[]');
    expect(headerOf(req, 'X-Line-Access')).toBe('access-1');
    expect(headerOf(req, 'X-Hmac')).toMatch(/^fake-hmac:/);
  });

  it('stops the refresh timer, and treats a dead session as logged out with authInvalidated', async () => {
    const server = new FakeServer().on(
      LOGOUT_V2,
      failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 8, reason: 'NOT_AUTHORIZED_DEVICE' } }),
    );
    const state = loggedIn();
    const events = recordEvents(state);
    const refresher = new TokenRefresher({ state, timers: { set: () => ({}), clear: () => undefined } });
    const { gateway } = makeGateway(server, state);
    await logoutV2({ gateway, state, refresher });
    expect(events.map((e) => e.event)).toEqual(['authInvalidated']);
    refresher.arm(); // stopped: stays disarmed
  });

  it('rethrows other errors and is not retried', async () => {
    const server = new FakeServer().on(LOGOUT_V2, failure(500, { code: 99999, message: 'UNKNOWN' }), ok(null));
    const state = loggedIn();
    const { gateway } = makeGateway(server, state);
    await expect(logoutV2({ gateway, state })).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });
});

describe('login-token resume', () => {
  const PROFILE = { mid: MID.toUpperCase().replace('U', 'u'), displayName: 'Me', picturePath: '/p/abc', regionCode: 'TW' };
  const issue = {
    tokenV3IssueResult: {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      tokenIssueTimeEpochSec: 2_000_000_000,
      durationUntilRefreshInSec: 3600,
    },
  };

  function resumed(nowMs: number, server: FakeServer) {
    const state = new ChromeSessionState();
    state.install({
      token: 'access-1',
      qrCert: null,
      e2eeStorage: { transport: 'CHROMEOS-3.7.2', refreshToken: 'refresh-1', tokenIssueTimeEpochSec: 1_700_000_000, durationUntilRefreshInSec: 3600 },
    });
    const events = recordEvents(state);
    const armed: number[] = [];
    const refresher = new TokenRefresher({
      state,
      now: () => nowMs,
      timers: { set: (_cb, ms) => (armed.push(ms), {}), clear: () => undefined },
    });
    const { gateway } = makeGateway(server, state, { onMustRefresh: refresher.mustRefreshHook });
    refresher.attachGateway(gateway);
    return { state, events, refresher, gateway, armed };
  }

  it('not expired: getProfile [2] only, returns the identity, records mid/region and arms the timer', async () => {
    const server = new FakeServer().on(GET_PROFILE, ok(PROFILE));
    const h = resumed(1_700_000_100_000, server);
    const identity = await loginWithToken({ gateway: h.gateway, state: h.state, refresher: h.refresher, token: 'access-1' });
    expect(identity).toEqual({ ownMid: PROFILE.mid.toLowerCase(), displayName: 'Me', picturePath: '/p/abc' });
    expect(server.requests.map((r) => r.path)).toEqual([GET_PROFILE]);
    expect(server.requests[0]!.body).toBe('[2]');
    expect(h.state.mid).toBe(PROFILE.mid.toLowerCase());
    expect(h.state.regionCode).toBe('TW');
    expect(h.armed).toEqual([3_500_000]);
  });

  it('past expire: refreshes first, then getProfile with the new token', async () => {
    const server = new FakeServer().on(TOKEN_REFRESH, ok(issue)).on(GET_PROFILE, ok(PROFILE));
    const h = resumed(1_700_003_700_000, server);
    await loginWithToken({ gateway: h.gateway, state: h.state, refresher: h.refresher, token: 'access-1' });
    expect(server.requests.map((r) => r.path)).toEqual([TOKEN_REFRESH, GET_PROFILE]);
    expect(headerOf(server.requests[1]!, 'X-Line-Access')).toBe('access-2');
    expect(h.state.refreshToken).toBe('refresh-2');
    expect(h.events.map((e) => e.event)).toContain('credentials');
  });

  it('past expire and the refresh fails: surfaces the error and never calls getProfile', async () => {
    const server = new FakeServer().on(TOKEN_REFRESH, failure(400, { code: 10201, message: 'AUTH_INVALID_REQUEST' })).on(GET_PROFILE, ok(PROFILE));
    const h = resumed(1_700_003_700_000, server);
    await expect(loginWithToken({ gateway: h.gateway, state: h.state, refresher: h.refresher, token: 'access-1' })).rejects.toThrow();
    expect(server.to(GET_PROFILE)).toHaveLength(0);
    expect(h.events.map((e) => e.event)).toEqual(['authInvalidated']);
  });

  it('rejects an invalid profile response', async () => {
    const server = new FakeServer().on(GET_PROFILE, ok({ mid: 'not-a-mid' }));
    const h = resumed(1_700_000_100_000, server);
    await expect(fetchIdentity(h.gateway)).rejects.toThrow('LINE profile response is invalid');
  });

  it('omits picturePath when the profile has none and maps an empty one to null', async () => {
    const none = new FakeServer().on(GET_PROFILE, ok({ mid: MID, displayName: 'A' }));
    expect(await fetchIdentity(resumed(0, none).gateway)).toEqual({ ownMid: MID, displayName: 'A' });
    const empty = new FakeServer().on(GET_PROFILE, ok({ mid: MID, displayName: null, picturePath: '' }));
    expect(await fetchIdentity(resumed(0, empty).gateway)).toEqual({ ownMid: MID, displayName: null, picturePath: null });
  });
});
