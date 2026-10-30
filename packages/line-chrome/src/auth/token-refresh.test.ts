import { describe, expect, it } from 'vitest';
import {
  ChromeSessionState,
  coerceNumber,
  pythonFloat,
  REFRESH_RETRY_DELAY_CAP_MS,
  TokenRefresher,
  parseRefreshPolicy,
  parseTokenIssue,
  type TimerApi,
} from '../index.js';
import { FakeServer, GET_PROFILE, TOKEN_REFRESH, failure, headerOf, makeGateway, ok, recordEvents } from './auth.testkit.js';

const POLICY = { initialDelayInMillis: 1000, maxDelayInMillis: 30000, multiplier: 2, jitterRate: 0.1 };
const NEW_ISSUE = {
  tokenV3IssueResult: {
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    tokenIssueTimeEpochSec: '1700003600',
    durationUntilRefreshInSec: '7200',
    refreshApiRetryPolicy: POLICY,
  },
};
const retry = () => failure(400, { code: 10202, message: 'AUTH_RETRY_REQUIRED' });
const kickout = () => failure(400, { code: 10201, message: 'AUTH_INVALID_REQUEST' });

class FakeTimers implements TimerApi {
  readonly scheduled: Array<{ id: number; callback: () => void; ms: number; cleared: boolean }> = [];
  set(callback: () => void, ms: number): unknown {
    const entry = { id: this.scheduled.length, callback, ms, cleared: false };
    this.scheduled.push(entry);
    return entry;
  }
  clear(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }
  get live() {
    return this.scheduled.filter((t) => !t.cleared);
  }
}

function setup(replies: { refresh?: Array<Response | (() => Response)>; profile?: Array<Response | (() => Response)> } = {}, nowMs = 1_700_000_000_000) {
  const state = new ChromeSessionState();
  state.install({
    token: 'access-1',
    qrCert: null,
    e2eeStorage: {
      transport: 'CHROMEOS-3.7.2',
      refreshToken: 'refresh-1',
      tokenIssueTimeEpochSec: 1_700_000_000,
      durationUntilRefreshInSec: 3600,
      expire: 1_700_003_600,
      'chrome:refreshApiRetryPolicy': POLICY,
    },
  });
  const events = recordEvents(state);
  const server = new FakeServer();
  if (replies.refresh) server.on(TOKEN_REFRESH, ...replies.refresh);
  if (replies.profile) server.on(GET_PROFILE, ...replies.profile);
  const clock = { now: nowMs };
  const timers = new FakeTimers();
  const sleeps: number[] = [];
  const sleepGate: { wait?: () => Promise<void> } = {};
  const rnd = { v: 0.5 };
  const refreshed: number[] = [];
  const refresher = new TokenRefresher({
    state,
    now: () => clock.now,
    timers,
    sleep: async (ms) => { sleeps.push(ms); await sleepGate.wait?.(); },
    random: () => rnd.v, // 0.5 = jitter factor exactly 1
    onRefreshed: () => void refreshed.push(clock.now),
  });
  const { gateway } = makeGateway(server, state, { onMustRefresh: refresher.mustRefreshHook });
  refresher.attachGateway(gateway);
  return { state, events, server, clock, timers, sleeps, sleepGate, rnd, refreshed, refresher, gateway };
}

describe('parseRefreshPolicy (OkLine RefreshApiRetryPolicy.parse)', () => {
  it('returns null for missing, empty or degenerate policies', () => {
    expect(parseRefreshPolicy(null)).toBeNull();
    expect(parseRefreshPolicy({})).toBeNull();
    expect(parseRefreshPolicy({ initialDelayInMillis: 5000, maxDelayInMillis: 5000 })).toBeNull();
  });
  it('coerces strings, applies defaults and clamps to 60 s', () => {
    expect(parseRefreshPolicy({ initialDelayInMillis: '500', maxDelayInMillis: '999999', multiplier: '3', jitterRate: '0.25' })).toEqual({
      initialDelayMs: 500,
      maxDelayMs: REFRESH_RETRY_DELAY_CAP_MS,
      multiplier: 3,
      jitterRate: 0.25,
    });
    expect(parseRefreshPolicy({ initialDelayInMillis: 100, multiplier: 1, jitterRate: 7 })).toEqual({
      initialDelayMs: 100,
      maxDelayMs: 30000,
      multiplier: 2, // multiplier must exceed 1
      jitterRate: 0.1,
    });
  });
});

describe('TokenRefresher timer', () => {
  it('arms at (issue + duration) * 1000 - now and fires a refresh', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] }, 1_700_000_000_000 + 1_000_000);
    h.refresher.arm();
    expect(h.timers.live).toHaveLength(1);
    expect(h.timers.live[0]!.ms).toBe(1_700_003_600_000 - 1_700_001_000_000); // 2_600_000

    // time passes; the timer fires at the boundary
    h.clock.now = 1_700_003_600_000;
    h.timers.live[0]!.callback();
    await h.refresher.refresh(); // single-flight: joins the refresh the timer started
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    // re-armed from the NEW schedule: (1700003600 + 7200) * 1000 - now
    expect(h.timers.scheduled).toHaveLength(2);
    expect(h.timers.scheduled[1]!.ms).toBe(7_200_000);
    expect(h.refreshed).toEqual([1_700_003_600_000]);
  });

  it('arms immediately (0 ms) when already past expiry and does nothing without a refresh token', () => {
    const past = setup({}, 1_800_000_000_000);
    past.refresher.arm();
    expect(past.timers.live[0]!.ms).toBe(0);

    const empty = new ChromeSessionState();
    const refresher = new TokenRefresher({ state: empty, timers: new FakeTimers() });
    refresher.arm(); // no schedule: no timer, no throw
  });

  it('stop() cancels the timer and prevents re-arming', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] });
    h.refresher.arm();
    h.refresher.stop();
    expect(h.timers.live).toHaveLength(0);
    h.refresher.arm();
    expect(h.timers.live).toHaveLength(0);
  });
});

describe('TokenRefresher refresh', () => {
  it('posts {"refreshToken"} signed with the current token and X-Line-Access after X-Hmac', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] });
    expect(await h.refresher.refresh()).toBe(true);
    const req = h.server.to(TOKEN_REFRESH)[0]!;
    expect(req.method).toBe('POST');
    expect(req.body).toBe('{"refreshToken":"refresh-1"}');
    expect(headerOf(req, 'X-Line-Access')).toBe('access-1');
    const names = req.headers.map(([n]) => n);
    expect(names.indexOf('X-Line-Access')).toBeGreaterThan(names.indexOf('X-Hmac'));
    expect(headerOf(req, 'X-Hmac')).toMatch(/^fake-hmac:/);
  });

  it('success rotates the tokens, persists through a credentials event and re-arms', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] });
    await h.refresher.refresh();
    expect(h.state.accessToken).toBe('access-2');
    expect(h.state.refreshToken).toBe('refresh-2');
    expect(h.state.expire).toBe(1_700_003_600 + 7200);
    // exactly one credentials event (token + whole snapshot); no token/storage events during refresh
    expect(h.events.map((e) => e.event)).toEqual(['credentials']);
    const value = h.events[0]!.value as { token: string; e2eeStorage: Record<string, unknown> };
    expect(value.token).toBe('access-2');
    expect(value.e2eeStorage).toMatchObject({ transport: 'CHROMEOS-3.7.2', refreshToken: 'refresh-2', expire: 1_700_010_800 });
    expect(h.timers.live).toHaveLength(1);
    expect(h.refreshed).toHaveLength(1);
  });

  it('10202 backs off initial * multiplier^n with jitter, each sleep capped, then succeeds', async () => {
    const h = setup({ refresh: [retry(), retry(), retry(), ok(NEW_ISSUE)] });
    expect(await h.refresher.refresh()).toBe(true);
    expect(h.sleeps).toEqual([1000, 2000, 4000]);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(4);
  });

  it('applies jitterRate around the delay', async () => {
    const lo = setup({ refresh: [retry(), ok(NEW_ISSUE)] });
    lo.rnd.v = 0; // factor 1 - 0.1
    await lo.refresher.refresh();
    expect(lo.sleeps[0]).toBeCloseTo(900);
    const hi = setup({ refresh: [retry(), ok(NEW_ISSUE)] });
    hi.rnd.v = 1; // factor 1 + 0.1
    await hi.refresher.refresh();
    expect(hi.sleeps[0]).toBeCloseTo(1100);
  });

  it('gives up when the delay reaches maxDelay (budget exhausted) and reports refreshFailure', async () => {
    const h = setup({ refresh: [retry(), retry(), retry(), retry(), retry(), retry(), ok(NEW_ISSUE)] });
    expect(await h.refresher.refresh()).toBe(false);
    // 1000, 2000, 4000, 8000, 16000 sleep; 32000 >= 30000 stops: 5 retries, 5 sleeps, 5 requests
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(5);
    expect(h.events.map((e) => e.event)).toEqual(['refreshFailure']);
    expect(h.state.accessToken).toBe('access-1'); // the old token stays
    expect(h.refreshed).toHaveLength(0);
  });

  it('caps a single sleep at 60 s', async () => {
    const h = setup({ refresh: [retry(), ok(NEW_ISSUE)] });
    h.state.install({
      token: 'access-1',
      qrCert: null,
      e2eeStorage: {
        transport: 'CHROMEOS-3.7.2',
        refreshToken: 'refresh-1',
        'chrome:refreshApiRetryPolicy': { initialDelayInMillis: 59000, maxDelayInMillis: 600000, multiplier: 2, jitterRate: 1 },
      },
    });
    h.rnd.v = 1; // factor 2 -> 118 s requested
    // after this sleep the delay (118 s) exceeds the budget, so the refresh gives up
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.sleeps).toEqual([60_000]);
  });

  it('without a policy a 10202 is not retried', async () => {
    const h = setup({ refresh: [retry(), ok(NEW_ISSUE)] });
    h.state.install({ token: 'access-1', qrCert: null, e2eeStorage: { transport: 'CHROMEOS-3.7.2', refreshToken: 'refresh-1' } });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('10201 emits authInvalidated, stops the timer and does not retry', async () => {
    const h = setup({ refresh: [kickout(), ok(NEW_ISSUE)] });
    h.refresher.arm();
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.events.map((e) => e.event)).toEqual(['authInvalidated']);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.timers.live).toHaveLength(0);
    expect(h.state.accessToken).toBe('access-1');
  });

  it('a 10201 envelope with a nested TalkException code is a plain failure, not a kickout', async () => {
    const h = setup({ refresh: [failure(400, { code: 10201, message: 'AUTH_INVALID_REQUEST', data: { name: 'TalkException', code: 5, reason: 'x' } }), ok(NEW_ISSUE)] });
    h.refresher.resume();
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.events.map((e) => e.event)).toEqual(['refreshFailure']);
    expect(h.state.accessToken).toBe('access-1');
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    h.refresher.arm();
    expect(h.timers.live).toHaveLength(1);
  });

  it('a nested data.code 10201 without an envelope code is a kickout', async () => {
    const h = setup({ refresh: [failure(400, { message: 'FAILED', data: { code: 10201 } }), ok(NEW_ISSUE)] });
    h.refresher.arm();
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.events.map((e) => e.event)).toEqual(['authInvalidated']);
    expect(h.timers.live).toHaveLength(0);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
  });

  it('a 10202 envelope with a nested code 5 is not retried', async () => {
    const h = setup({ refresh: [failure(400, { code: 10202, data: { code: 5 } }), ok(NEW_ISSUE)] });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.events.map((e) => e.event)).toEqual(['refreshFailure']);
    expect(h.sleeps).toEqual([]);
  });

  it('a nested data.code 10202 without an envelope code backs off like a 10202 envelope', async () => {
    const nested = () => failure(400, { message: 'FAILED', data: { code: 10202 } });
    const h = setup({ refresh: [nested(), nested(), nested(), ok(NEW_ISSUE)] });
    expect(await h.refresher.refresh()).toBe(true);
    expect(h.sleeps).toEqual([1000, 2000, 4000]);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(4);
  });

  it('a 10201 PLEASE UPGRADE answer on tokenRefresh is still a kickout', async () => {
    const h = setup({ refresh: [failure(400, { code: 10201, message: 'PLEASE UPGRADE' }), ok(NEW_ISSUE)] });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.events.map((e) => e.event)).toEqual(['authInvalidated']);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
  });

  it('a 10201 on an ordinary read is not a kickout and does not invalidate the session', async () => {
    const h = setup({ profile: [failure(400, { code: 10201, message: 'x' }), failure(400, { code: 10202, message: 'x' })] });
    const first = await h.gateway.call('Talk.TalkService.getProfile', [2], { mode: 'read' }).catch((x: unknown) => x);
    expect(first).toBeInstanceOf(Error);
    expect(h.events).toEqual([]);
    await h.gateway.call('Talk.TalkService.getProfile', [2], { mode: 'read' }).catch((x: unknown) => x);
    expect(h.server.to(GET_PROFILE)).toHaveLength(2);
    expect(h.events).toEqual([]);
  });

  it('is single-flight: concurrent callers share one request', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] });
    const [a, b] = await Promise.all([h.refresher.refresh(), h.refresher.refresh()]);
    expect([a, b]).toEqual([true, true]);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
  });

  it('a response without an access token fails and keeps the old credentials', async () => {
    const h = setup({ refresh: [ok({ tokenV3IssueResult: {} })] });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.state.refreshToken).toBe('refresh-1');
  });

  it('a failing onRefreshed hook does not undo a successful refresh', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] });
    h.refresher.setOnRefreshed(() => {
      throw new Error('reconnect failed');
    });
    expect(await h.refresher.refresh()).toBe(true);
    expect(h.state.accessToken).toBe('access-2');
  });
});

describe('inner 119 through the gateway', () => {
  const must119 = () =>
    failure(400, { code: 10051, message: 'RESPONSE_ERROR', data: { name: 'TalkException', code: 119, reason: 'refresh' } });

  it('refreshes immediately, then replays the read once with the new token and a fresh signature', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)], profile: [must119(), ok({ mid: 'u' + 'a'.repeat(32) })] });
    const data = await h.gateway.call('Talk.TalkService.getProfile', [2], { mode: 'read' });
    expect(data).toEqual({ mid: 'u' + 'a'.repeat(32) });
    expect(h.server.requests.map((r) => r.path)).toEqual([GET_PROFILE, TOKEN_REFRESH, GET_PROFILE]);
    const [first, , replay] = h.server.requests;
    expect(headerOf(first!, 'X-Line-Access')).toBe('access-1');
    expect(headerOf(replay!, 'X-Line-Access')).toBe('access-2');
    expect(headerOf(replay!, 'X-Hmac')).not.toBe(headerOf(first!, 'X-Hmac'));
    expect(h.refreshed).toHaveLength(1);
  });
});

describe('TokenRefresher.invalidate (QR login starts a new session)', () => {
  it('stops the timer and discards the answer of a refresh that was in flight', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const h = setup({ refresh: [async () => { await released; return ok(NEW_ISSUE); }] });
    h.refresher.arm();
    const pending = h.refresher.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    h.refresher.invalidate();
    release();
    expect(await pending).toBe(false);
    expect(h.state.accessToken).toBe('access-1'); // the answer was not adopted
    expect(h.events).toEqual([]); // no credentials event and no refreshFailure
    expect(h.refreshed).toHaveLength(0);
    expect(h.timers.live).toHaveLength(0);
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const hold = () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    return { released, release };
  };

  it('a refresh in its 10202 sleep sends no further POST after invalidate()', async () => {
    const h = setup({ refresh: [retry(), ok(NEW_ISSUE)] });
    const sleepHold = hold();
    h.sleepGate.wait = () => sleepHold.released;
    const pending = h.refresher.refresh();
    await tick();
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.sleeps).toHaveLength(1);
    h.refresher.invalidate();
    sleepHold.release();
    expect(await pending).toBe(false);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.events).toEqual([]);
    expect(h.state.accessToken).toBe('access-1');
  });

  it('a 10201 answer after invalidate() emits nothing, keeps the token and lets resume() + arm() arm the timer', async () => {
    const answer = hold();
    const h = setup({ refresh: [async () => { await answer.released; return kickout(); }] });
    const pending = h.refresher.refresh();
    await tick();
    h.refresher.invalidate();
    answer.release();
    expect(await pending).toBe(false);
    expect(h.events).toEqual([]);
    expect(h.state.accessToken).toBe('access-1');
    h.refresher.resume();
    h.refresher.arm();
    expect(h.timers.live).toHaveLength(1);
  });

  it('a transport error after invalidate() emits no refreshFailure', async () => {
    const answer = hold();
    const h = setup({ refresh: [async () => { await answer.released; throw new TypeError('socket reset'); }] });
    const pending = h.refresher.refresh();
    await tick();
    h.refresher.invalidate();
    answer.release();
    expect(await pending).toBe(false);
    expect(h.events).toEqual([]);
  });

  it('invalidate(), resume(), refresh() sends a new POST and adopts its answer', async () => {
    const answer = hold();
    const h = setup({ refresh: [async () => { await answer.released; return ok({ tokenV3IssueResult: { accessToken: 'stale' } }); }, ok(NEW_ISSUE)] });
    const old = h.refresher.refresh();
    await tick();
    h.refresher.invalidate();
    h.refresher.resume();
    expect(await h.refresher.refresh()).toBe(true);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(2);
    expect(h.state.accessToken).toBe('access-2');
    answer.release();
    expect(await old).toBe(false);
    expect(h.state.accessToken).toBe('access-2');
  });

  it('a later refresh after resume() works again', async () => {
    const h = setup({ refresh: [ok(NEW_ISSUE)] });
    h.refresher.invalidate();
    h.refresher.resume();
    expect(await h.refresher.refresh()).toBe(true);
    expect(h.state.accessToken).toBe('access-2');
  });
});

describe('refresh answer needs accessToken (OkLine auth.py:1082-1087)', () => {
  it('a refresh answer with only authToken fails: token unchanged, refreshFailure, no reconnect hook', async () => {
    const h = setup({ refresh: [ok({ authToken: 'x' })] });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.state.accessToken).toBe('access-1');
    expect(h.events.map((e) => e.event)).toEqual(['refreshFailure']);
    expect(h.refreshed).toHaveLength(0);
  });
  it('parseTokenIssue reads authToken only when allowAuthToken is true', () => {
    expect(parseTokenIssue({ authToken: 'x' })).toBeNull();
    expect(parseTokenIssue({ authToken: 'x' }, { allowAuthToken: true })?.accessToken).toBe('x');
    expect(parseTokenIssue({ accessToken: 'y', authToken: 'x' })?.accessToken).toBe('y');
  });
  it('login flow reads the outer authToken and ignores the outer accessToken', () => {
    const issue = parseTokenIssue({ accessToken: 'A', authToken: 'B' }, { allowAuthToken: true });
    expect(issue?.accessToken).toBe('B');
    expect(issue?.refreshToken).toBeNull();
    expect(issue?.tokenIssueTimeEpochSec).toBeNull();
    expect(issue?.durationUntilRefreshInSec).toBeNull();
    expect(issue?.refreshApiRetryPolicy).toBeNull();
    expect(parseTokenIssue({ accessToken: 'A' }, { allowAuthToken: true })).toBeNull();
  });
  it('login flow prefers tokenV3IssueResult.accessToken, else the outer authToken', () => {
    const nested = parseTokenIssue({ tokenV3IssueResult: { accessToken: 'A', refreshToken: 'r' }, authToken: 'B' }, { allowAuthToken: true });
    expect(nested?.accessToken).toBe('A');
    expect(nested?.refreshToken).toBe('r');
    const fallback = parseTokenIssue(
      { tokenV3IssueResult: { refreshToken: 'r' }, accessToken: 'C', authToken: 'B' },
      { allowAuthToken: true },
    );
    expect(fallback?.accessToken).toBe('B');
    expect(fallback?.refreshToken).toBe('r');
  });
  it('refresh flow reads the outer accessToken and never the authToken', () => {
    expect(parseTokenIssue({ accessToken: 'A' })?.accessToken).toBe('A');
    const mixed = parseTokenIssue({ tokenV3IssueResult: { refreshToken: 'r' }, accessToken: 'A' });
    expect(mixed?.accessToken).toBe('A');
    expect(mixed?.refreshToken).toBe('r');
    expect(parseTokenIssue({ authToken: 'x' })).toBeNull();
  });
});

describe('Python float() parsing (OkLine auth.py:127-136)', () => {
  const policyOf = (extra: Record<string, unknown>) =>
    parseRefreshPolicy({ initialDelayInMillis: 1000, maxDelayInMillis: 30000, multiplier: 2, jitterRate: 0, ...extra });

  it('a hex string is not a number: the policy is null and a 10202 is not retried', async () => {
    const raw = { initialDelayInMillis: '0x10', maxDelayInMillis: 1000, multiplier: 2, jitterRate: 0 };
    expect(parseRefreshPolicy(raw)).toBeNull();
    const h = setup({ refresh: [retry(), retry(), retry()] });
    h.state.install({
      token: 'access-1',
      qrCert: null,
      e2eeStorage: { transport: 'CHROMEOS-3.7.2', refreshToken: 'refresh-1', 'chrome:refreshApiRetryPolicy': raw },
    });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.events.map((e) => e.event)).toEqual(['refreshFailure']);
  });

  it('underscore digits parse like the number without underscores', async () => {
    expect(parseRefreshPolicy({ initialDelayInMillis: '1_000', maxDelayInMillis: 30000 })?.initialDelayMs).toBe(1000);
    const count = async (initial: string | number) => {
      const h = setup({ refresh: Array.from({ length: 12 }, () => retry()) });
      h.state.install({
        token: 'access-1',
        qrCert: null,
        e2eeStorage: {
          transport: 'CHROMEOS-3.7.2',
          refreshToken: 'refresh-1',
          'chrome:refreshApiRetryPolicy': { initialDelayInMillis: initial, maxDelayInMillis: 30000, multiplier: 2, jitterRate: 0 },
        },
      });
      await h.refresher.refresh();
      return h.server.to(TOKEN_REFRESH).length;
    };
    expect(await count('1_000')).toBe(await count(1000));
  });

  it('inf, nan, exponent and whitespace forms', () => {
    expect(policyOf({ initialDelayInMillis: 'inf' })).toBeNull();
    expect(policyOf({ maxDelayInMillis: 'inf' })?.maxDelayMs).toBe(60000);
    for (const key of ['initialDelayInMillis', 'maxDelayInMillis', 'multiplier']) {
      expect(policyOf({ [key]: 'nan' })).toBeNull();
    }
    expect(policyOf({ jitterRate: 'nan' })?.jitterRate).toBe(0.1);
    expect(policyOf({ initialDelayInMillis: '1e3' })?.initialDelayMs).toBe(1000);
    expect(policyOf({ initialDelayInMillis: ' 1000 ' })?.initialDelayMs).toBe(1000);
    expect(policyOf({ multiplier: 'INF' })?.multiplier).toBe(1000);
  });

  it('parseTokenIssue rejects a hex issue time and accepts underscore digits', () => {
    const run = (issueTime: string) => {
      const state = new ChromeSessionState();
      state.install({ token: 'access-1', qrCert: null, e2eeStorage: { transport: 'CHROMEOS-3.7.2', refreshToken: 'refresh-1' } });
      const timers = new FakeTimers();
      const refresher = new TokenRefresher({ state, timers, now: () => 1_700_000_000_000 });
      const issue = parseTokenIssue({ accessToken: 'a2', refreshToken: 'r2', tokenIssueTimeEpochSec: issueTime, durationUntilRefreshInSec: 3600 });
      expect(issue).not.toBeNull();
      state.adoptRefresh(issue!);
      refresher.arm();
      return { issue: issue!, timers };
    };
    const bad = run('0x10');
    expect(bad.issue.tokenIssueTimeEpochSec).toBeNull();
    expect(bad.timers.live).toHaveLength(0);
    const good = run('1_700_000_000');
    expect(good.issue.tokenIssueTimeEpochSec).toBe(1700000000);
    expect(good.timers.live).toHaveLength(1);
  });

  it('coerceNumber and pythonFloat', () => {
    expect(coerceNumber('inf')).toBeNull();
    expect(pythonFloat('inf')).toBe(Infinity);
    expect(pythonFloat('-Infinity')).toBe(-Infinity);
    expect(pythonFloat('nan')).toBeNaN();
    expect(pythonFloat('')).toBeNull();
    expect(pythonFloat('1.')).toBe(1);
    expect(pythonFloat('.5')).toBe(0.5);
    expect(pythonFloat('+1.5E-2')).toBe(0.015);
    for (const bad of ['0x10', '0b1', '0o7', '1__0', '_1', '1_', '1e_5', '.', '1.2.3']) expect(pythonFloat(bad)).toBeNull();
    expect(pythonFloat(true)).toBeNull();
    expect(pythonFloat(null)).toBeNull();
    expect(pythonFloat({})).toBeNull();
  });
});

describe('refresh answer with a text/plain body and a leading space (OkLine transport.py:735-742)', () => {
  it('is not parsed: refresh() is false, refreshFailure, token unchanged, one POST, no reconnect hook', async () => {
    const body = ' {"message":"OK","data":{"accessToken":"n","refreshToken":"r"}}';
    const h = setup({ refresh: [new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })] });
    expect(await h.refresher.refresh()).toBe(false);
    expect(h.state.accessToken).toBe('access-1');
    expect(h.events.map((e) => e.event)).toEqual(['refreshFailure']);
    expect(h.server.to(TOKEN_REFRESH)).toHaveLength(1);
    expect(h.refreshed).toHaveLength(0);
  });
});
