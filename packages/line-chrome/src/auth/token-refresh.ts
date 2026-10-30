// Token refresh lifecycle. Ported from OkLine okline/auth.py:1000-1148 (refresh_access_token, retry policy, schedule),
// okline/client.py:144-250 (single-flight, proactive timer, reconnect after renewal).

import type { ChromeGateway } from '../gateway.js';
import { specialPath } from '../endpoints.js';
import { pythonFloat } from '../json.js';
import { ChromeAuthError, ChromeError, ChromeRefreshKickoutError, ChromeRefreshRetryError } from '../errors.js';
import type { ChromeSessionState, RawRefreshPolicy, TokenIssue } from './session-state.js';

/** OkLine auth.py:38 REFRESH_RETRY_DELAY_CAP_MS: server-provided delays are clamped client-side at 60 s. */
export const REFRESH_RETRY_DELAY_CAP_MS = 60_000;
/** setTimeout cannot exceed a signed 32-bit delay; a longer wait re-arms itself. */
const MAX_TIMER_MS = 2_147_000_000;

/** The refresh retried through the whole 10202 budget without success (OkLine raises LineAuthError). */
export class ChromeRefreshExhaustedError extends ChromeAuthError {}
/** The refresh response carried no access token, or no refresh token is available. */
export class ChromeRefreshUnavailableError extends ChromeError {}
/** A refresh answer arrived after `invalidate()`. The answer is discarded and no state changes. */
export class ChromeRefreshDiscardedError extends ChromeError {}

/** OkLine RefreshApiRetryPolicy (auth.py:60-125). */
export interface RefreshApiRetryPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRate: number;
}

/** Python `float(value)` for finite results only (auth.py:127-136). Inf and NaN give null. */
export function coerceNumber(value: unknown): number | null {
  const n = pythonFloat(value);
  return n !== null && Number.isFinite(n) ? n : null;
}

/**
 * OkLine RefreshApiRetryPolicy.parse (auth.py:94-125): unusable fields take defaults, both delays are clamped to 60 s,
 * and a missing or degenerate (initial >= max) policy returns null, meaning one attempt only.
 */
export function parseRefreshPolicy(data: unknown): RefreshApiRetryPolicy | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || Object.keys(data).length === 0) return null;
  const block = data as Record<string, unknown>;
  const num = (key: string, fallback: number, minimum: number, maximum: number): number => {
    const value = pythonFloat(block[key]);
    if (value === null || value <= minimum) return fallback;
    return Math.min(value, maximum);
  };
  const jitter = pythonFloat(block.jitterRate);
  const policy: RefreshApiRetryPolicy = {
    initialDelayMs: num('initialDelayInMillis', 1000, 0, REFRESH_RETRY_DELAY_CAP_MS),
    maxDelayMs: num('maxDelayInMillis', 30_000, 0, REFRESH_RETRY_DELAY_CAP_MS),
    multiplier: num('multiplier', 2, 1, 1000),
    jitterRate: jitter !== null && jitter >= 0 && jitter <= 1 ? jitter : 0.1,
  };
  // Python float("nan") passes the range checks, so a NaN delay field makes the policy unusable.
  if (Number.isNaN(policy.initialDelayMs) || Number.isNaN(policy.maxDelayMs) || Number.isNaN(policy.multiplier)) return null;
  if (policy.initialDelayMs >= policy.maxDelayMs) return null;
  return policy;
}

/**
 * Build a TokenIssue from a `tokenV3IssueResult` (or a bare refresh response). Null when no access token.
 * `allowAuthToken: true` means the login flow (OkLine auth.py:242-245): read `tokenV3IssueResult.accessToken`,
 * then the outer `authToken`, and nothing else.
 * Refresh (OkLine auth.py:1082-1087): read `tokenV3IssueResult.accessToken`, then the outer `accessToken`.
 */
export function parseTokenIssue(data: unknown, options: { allowAuthToken?: boolean } = {}): TokenIssue | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const outer = data as Record<string, unknown>;
  const nested = outer.tokenV3IssueResult;
  const login = options.allowAuthToken === true;
  const tok = (typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? nested : login ? {} : outer) as Record<string, unknown>;
  const access = (typeof tok.accessToken === 'string' && tok.accessToken !== '' ? tok.accessToken : undefined) ??
    (login
      ? (typeof outer.authToken === 'string' && outer.authToken !== '' ? outer.authToken : undefined)
      : (typeof outer.accessToken === 'string' && outer.accessToken !== '' ? outer.accessToken : undefined));
  if (access === undefined) return null;
  const policy = tok.refreshApiRetryPolicy;
  return {
    accessToken: access,
    refreshToken: typeof tok.refreshToken === 'string' && tok.refreshToken !== '' ? tok.refreshToken : null,
    tokenIssueTimeEpochSec: coerceNumber(tok.tokenIssueTimeEpochSec),
    durationUntilRefreshInSec: coerceNumber(tok.durationUntilRefreshInSec),
    refreshApiRetryPolicy:
      typeof policy === 'object' && policy !== null && !Array.isArray(policy) ? (policy as RawRefreshPolicy) : null,
  };
}

export interface TimerApi {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface TokenRefresherOptions {
  state: ChromeSessionState;
  /** May be attached later with `attachGateway` (the gateway needs `refresher.mustRefreshHook` at construction). */
  gateway?: ChromeGateway;
  /** Wall clock in milliseconds. */
  now?: () => number;
  timers?: TimerApi;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1) source for the backoff jitter. */
  random?: () => number;
  /** Fires after a successful refresh, after persistence and re-arm. Step 4 reconnects SSE here. */
  onRefreshed?: () => void | Promise<void>;
}

export class TokenRefresher {
  private readonly state: ChromeSessionState;
  private gateway: ChromeGateway | undefined;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private onRefreshed: (() => void | Promise<void>) | undefined;
  private timer: unknown;
  private generation = 0;
  private active = true;
  private inFlight: Promise<boolean> | undefined;
  /** Counts the calls to `invalidate()`. A refresh that started in an older epoch must not adopt its answer. */
  private epoch = 0;

  constructor(options: TokenRefresherOptions) {
    this.state = options.state;
    this.gateway = options.gateway;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.onRefreshed = options.onRefreshed;
  }

  attachGateway(gateway: ChromeGateway): void {
    this.gateway = gateway;
  }

  setOnRefreshed(hook: (() => void | Promise<void>) | undefined): void {
    this.onRefreshed = hook;
  }

  /** Pass this as `GatewayOptions.onMustRefresh` (inner TalkException 119): refresh now, then the gateway replays once. */
  readonly mustRefreshHook = (): Promise<boolean> => this.refresh();

  // -- schedule ---------------------------------------------------------------------------------------------------

  /**
   * Arms the one-shot timer at `(tokenIssueTimeEpochSec + durationUntilRefreshInSec) * 1000 - now` (extension
   * setTokenV3IssueResult, OkLine client.py:192-221; the port-side random early margin is not added). A previous timer
   * is cancelled. Does nothing without a schedule and a refresh token.
   */
  arm(): void {
    this.cancelTimer();
    if (!this.active) return;
    const expire = this.state.expire;
    if (expire === null || !this.state.refreshToken) return;
    const generation = ++this.generation;
    const fireAtMs = expire * 1000;
    const delay = Math.max(0, fireAtMs - this.now());
    this.timer = this.timers.set(() => {
      if (!this.active || generation !== this.generation) return;
      this.timer = undefined;
      if (this.now() < fireAtMs - 1000) {
        this.arm(); // the delay was capped at the timer limit; keep waiting
        return;
      }
      void this.refresh().catch(() => {
        /* refresh() already reported through refreshFailure / authInvalidated */
      });
    }, Math.min(delay, MAX_TIMER_MS));
  }

  /** Cancels the timer and stops re-arming (revoke / logout). */
  stop(): void {
    this.active = false;
    this.cancelTimer();
  }

  /** Stops the timer and discards any refresh that is in flight (QR login starts a new session). */
  invalidate(): void {
    this.stop();
    this.epoch += 1;
    // A refresh that starts after this call must not join the discarded one.
    this.inFlight = undefined;
  }

  /** Throws when `invalidate()` ran after the refresh with this epoch started. */
  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new ChromeRefreshDiscardedError('token refresh answer discarded');
  }

  /** Re-enables scheduling after `stop()`. */
  resume(): void {
    this.active = true;
  }

  private cancelTimer(): void {
    this.generation += 1;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  /** True when the stored expiry has passed (login-token path). */
  isExpired(): boolean {
    const expire = this.state.expire;
    return expire !== null && expire * 1000 <= this.now();
  }

  // -- refresh ----------------------------------------------------------------------------------------------------

  /**
   * Single-flight refresh. Resolves true on success. On failure it reports to the worker and resolves false (the
   * 119 hook and timer must never throw): 10201 emits `authInvalidated`; any other failure emits `refreshFailure`.
   */
  refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const run = this.performRefresh().finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  /** Same as `refresh()` but rethrows the cause, for callers that must surface it (resume path). */
  async refreshOrThrow(): Promise<void> {
    if (this.inFlight) {
      if (!(await this.inFlight)) throw this.lastError ?? new ChromeRefreshUnavailableError('token refresh failed');
      return;
    }
    this.lastError = undefined;
    if (!(await this.refresh())) throw this.lastError ?? new ChromeRefreshUnavailableError('token refresh failed');
  }

  private lastError: unknown;

  private async performRefresh(): Promise<boolean> {
    this.lastError = undefined;
    try {
      await this.refreshCore();
    } catch (error) {
      if (error instanceof ChromeRefreshDiscardedError) return false;
      this.lastError = error;
      if (error instanceof ChromeRefreshKickoutError) {
        this.stop();
        this.state.emit('authInvalidated');
      } else {
        this.state.emit('refreshFailure', { code: 'LINE_TOKEN_REFRESH_FAILED' });
      }
      return false;
    }
    this.arm();
    if (this.onRefreshed) {
      try {
        await this.onRefreshed();
      } catch {
        /* a reconnect hook must not undo a successful refresh */
      }
    }
    return true;
  }

  /** OkLine refresh_access_token (auth.py:1031-1098). Throws on any failure; success adopts the new tokens. */
  private async refreshCore(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) throw new ChromeRefreshUnavailableError('no gateway attached to the token refresher');
    const refreshToken = this.state.refreshToken;
    if (!refreshToken) throw new ChromeRefreshUnavailableError('no refresh token available');
    const epoch = this.epoch;
    const policy = parseRefreshPolicy(this.state.refreshApiRetryPolicy);
    let delayMs = policy ? policy.initialDelayMs : 0;
    for (;;) {
      if (policy && delayMs >= policy.maxDelayMs) {
        // The bundle's `for (; i < maxDelayInMillis;)` exit: every retry budget spent while the server said 10202.
        throw new ChromeRefreshExhaustedError(
          `token refresh failed: AUTH_RETRY_REQUIRED retry budget exhausted (initial=${policy.initialDelayMs}ms, ` +
            `max=${policy.maxDelayMs}ms, multiplier=${policy.multiplier})`,
        );
      }
      this.assertEpoch(epoch);
      let data: unknown;
      const accessToken = this.state.accessToken;
      try {
        // The extension's header mapper attaches X-Line-Access to every request when a token exists, tokenRefresh
        // included (OkLine auth.py:1060-1070). requireAuth stays false so a token-less refresh still proceeds; the
        // header goes after X-Hmac like OkLine's extra_headers. A refresh rotates the refresh token, so it is a
        // 'write': the gateway never retries it, only the 10202 loop below does.
        data = await gateway.postJson(
          specialPath('auth.tokenRefresh'),
          { refreshToken },
          {
            mode: 'write',
            requireAuth: false,
            ...(accessToken ? { extraHeaders: { 'X-Line-Access': accessToken } } : {}),
          },
        );
      } catch (error) {
        this.assertEpoch(epoch);
        if (error instanceof ChromeRefreshKickoutError) throw error; // 10201: hard kickout (auth.py:1075-1081)
        if (!policy || !(error instanceof ChromeRefreshRetryError)) throw error;
        // 10202: jittered backoff, then grow the delay (the bundle's tT.renewToken loop). Each sleep is capped at 60 s.
        const jitter = 1 - policy.jitterRate + this.random() * 2 * policy.jitterRate;
        await this.sleep(Math.min(delayMs * jitter, REFRESH_RETRY_DELAY_CAP_MS));
        this.assertEpoch(epoch);
        delayMs *= policy.multiplier;
        continue;
      }
      if (epoch !== this.epoch) throw new ChromeRefreshDiscardedError('token refresh answer discarded');
      const issue = parseTokenIssue(data);
      if (!issue) throw new ChromeRefreshUnavailableError('token refresh returned no access token');
      this.state.adoptRefresh(issue);
      return;
    }
  }
}
