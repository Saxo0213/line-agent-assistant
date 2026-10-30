// SSE operation receiver. Port of OkLine okline/operations.py (OperationReceiver.stream/_open_sse/iter_operations,
// :218-480), with the keepalive rewritten per design ruling 4 to follow the REAL extension rather than OkLine's opt-in
// pinger:
//   - NO ping requests. The extension's PingInterceptor is a silence watchdog, not traffic.
//   - Reopen after 30 s without any received event; any received event resets the failed-attempt count.
//   - Failed connections back off min(2^n s, 600 s) and stop after 144 consecutive failures (the bundle's Dd/_R); the
//     receiver then reports `disconnected` and nothing restarts it automatically.
//   - A connection that delivered events reconnects immediately.
//   - A token refresh reconnects an open stream (extension tT.renewToken -> connect()).

import { CHROME_EXTENSION_VERSION, DEFAULT_LOCALE, lalForLocale } from '../constants.js';
import { specialPath } from '../endpoints.js';
import { ChromeError, ChromeLoginRequiredError, extractErrorInfo } from '../errors.js';
import type { ChromeGateway, QueryParams } from '../gateway.js';
import { parsePreciseJson } from '../json.js';
import { SseParser, type SseFrame } from './sse-parser.js';
import { opRevision, toRevision, type ChromeOperation } from './types.js';

export const SSE_SILENCE_TIMEOUT_MS = 30_000;
export const SSE_MAX_FAILED_ATTEMPTS = 144;
export const SSE_BACKOFF_CAP_MS = 600_000;
const SSE_OPEN_TIMEOUT_MS = 30_000;

/** OkLine `_reconnect_delay` with the bundle's constants: `min(2^n * 1 s, 600 s)` for the n-th failure (0-based). */
export function sseBackoffMs(failureIndex: number): number {
  return Math.min(2 ** Math.min(Math.max(failureIndex, 0), 62) * 1000, SSE_BACKOFF_CAP_MS);
}

/** Injectable clock; tests drive time by hand. */
export interface ReceiveClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: ReceiveClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type SseAuthMode = 'header' | 'cookie';

export type ReceiverState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting'; readonly failures: number }
  | { readonly kind: 'open' }
  | { readonly kind: 'backoff'; readonly failures: number; readonly delayMs: number; readonly error: string | null }
  /** Terminal: 144 failures in a row, or an auth rejection. Needs a manual start()/reopen(). */
  | { readonly kind: 'disconnected'; readonly failures: number; readonly error: string | null; readonly authRejected: boolean }
  | { readonly kind: 'stopped' };

/** Where received data goes (implemented by `ReceiveBuffer`). */
export interface ReceiverSink {
  /** A new stream epoch begins at `localRev` (after any seeding). Everything delivered afterwards is > localRev. */
  onEpoch(localRev: string): void;
  onOperations(operations: ChromeOperation[]): void;
  /** fullSync / partialFullSync `nextRevision`: a cursor jump. */
  onFullSync(nextRevision: string): void;
}

export interface TalkExceptionInfo {
  readonly code: number | undefined;
  readonly reason: string | undefined;
  readonly data: unknown;
}

export interface SseReceiverOptions {
  gateway: ChromeGateway;
  sink: ReceiverSink;
  /** Default 'header' (OkLine). 'cookie' sends only `Cookie: lct=<token>` and needs `getAccessToken`. Stays off by default. */
  sseAuth?: SseAuthMode;
  getAccessToken?: () => string | undefined;
  locale?: string;
  legyHost?: string;
  /** Sent on the first connect of a session only. Omitted when undefined. */
  fullSyncRequestReason?: string;
  clock?: ReceiveClock;
  silenceTimeoutMs?: number;
  maxFailedAttempts?: number;
  onState?: (state: ReceiverState) => void;
  onTalkException?: (info: TalkExceptionInfo) => void;
  /** Called with the error of every failed connection attempt. */
  onError?: (error: unknown) => void;
}

export class ChromeSseOpenError extends ChromeError {
  readonly status: number;
  constructor(status: number) {
    super(`SSE open failed: HTTP ${status}`);
    this.status = status;
  }
}

interface ConnectResult {
  events: number;
  error: unknown;
  /** Do not retry: auth rejection or no credentials. */
  fatal: boolean;
}

const SYNC_EVENTS = new Set(['fullSync', 'partialFullSync']);
/** Events that never carry operations (OkLine operations.py:89-91 `_SKIP_EVENTS`). */
const SKIP_EVENTS = new Set(['ping', 'reconnect', 'connInfoRevision', ...SYNC_EVENTS]);

export class ChromeSseReceiver {
  private readonly o: SseReceiverOptions;
  private readonly clock: ReceiveClock;
  private readonly silenceMs: number;
  private readonly maxFailures: number;
  private readonly authMode: SseAuthMode;
  private readonly language: string;

  private gen = 0;
  private current: AbortController | undefined;
  private wake: (() => void) | undefined;
  private sleepHandle: unknown;
  private currentState: ReceiverState = { kind: 'idle' };
  private rev = '0';
  private firstConnect = true;
  private epochPending = false;
  private seedPending = false;
  /** The revision read from getLastOpRevision in this session. One seed per start(); a reopen at 0 reuses it. */
  private seeded: string | null = null;
  /** True while the seed call `getLastOpRevision` runs. `reconnect()` does nothing then. */
  private seeding = false;

  constructor(options: SseReceiverOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.silenceMs = options.silenceTimeoutMs ?? SSE_SILENCE_TIMEOUT_MS;
    this.maxFailures = options.maxFailedAttempts ?? SSE_MAX_FAILED_ATTEMPTS;
    this.authMode = options.sseAuth ?? 'header';
    this.language = lalForLocale(options.locale ?? DEFAULT_LOCALE);
  }

  get state(): ReceiverState {
    return this.currentState;
  }

  /** The resume cursor sent as `localRev` on the next open. */
  get localRev(): string {
    return this.rev;
  }

  /** Begins a session at `localRev` ("0" seeds once from `getLastOpRevision`). The first connect may carry fullSyncRequestReason. */
  start(localRev: string): void {
    this.firstConnect = true;
    this.seeded = null;
    this.begin(localRev, true);
  }

  /** Closes the stream and reopens at `localRev` (the buffer's gap/overflow recovery). Works from any state, including disconnected. */
  reopen(localRev: string): void {
    this.begin(localRev, true);
  }

  /**
   * After a token refresh: reconnect at the current cursor, only when a stream is live or retrying (the extension's
   * `readyState === OPENED && connect()`). A terminal `disconnected`/`stopped`/`idle` receiver stays as it is.
   */
  reconnect(): boolean {
    if (this.seeding) return false;
    const k = this.currentState.kind;
    if (k !== 'connecting' && k !== 'open' && k !== 'backoff') return false;
    this.begin(this.rev, false);
    return true;
  }

  stop(): void {
    this.gen += 1;
    this.abortCurrent();
    this.cancelSleep();
    this.setState({ kind: 'stopped' });
  }

  /** Same as `stop()`, and the next session seeds again. A new login uses this. The overflow stop keeps `stop()`. */
  reset(): void {
    this.stop();
    this.seeded = null;
  }

  // -- run loop -----------------------------------------------------------------------------------------------------

  private begin(localRev: string, newEpoch: boolean): void {
    this.gen += 1;
    this.abortCurrent();
    this.cancelSleep();
    this.rev = normaliseRevision(localRev);
    if (newEpoch) {
      this.epochPending = true;
      // A reopen at 0 after a seed continues from that seed. It does not read a newer revision, because that skips operations.
      this.seedPending = false;
      if (this.rev === '0') {
        if (this.seeded === null) this.seedPending = true;
        else this.rev = this.seeded;
      }
    }
    this.setState({ kind: 'connecting', failures: 0 });
    void this.run(this.gen);
  }

  private async run(gen: number): Promise<void> {
    let failures = 0;
    try {
      while (gen === this.gen) {
        this.setState({ kind: 'connecting', failures });
        const result = await this.connectOnce(gen);
        if (gen !== this.gen) return;
        if (result.fatal) {
          this.setState({ kind: 'disconnected', failures: failures + 1, error: describe(result.error), authRejected: true });
          this.o.onError?.(result.error);
          return;
        }
        if (result.events > 0) {
          failures = 0; // a productive connection: reconnect immediately
          continue;
        }
        failures += 1;
        this.o.onError?.(result.error);
        if (failures >= this.maxFailures) {
          this.setState({ kind: 'disconnected', failures, error: describe(result.error), authRejected: false });
          return;
        }
        const delayMs = sseBackoffMs(failures - 1);
        this.setState({ kind: 'backoff', failures, delayMs, error: describe(result.error) });
        await this.sleep(delayMs);
      }
    } catch (error) {
      if (gen === this.gen) {
        this.setState({ kind: 'disconnected', failures, error: describe(error), authRejected: false });
        this.o.onError?.(error);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.sleepHandle = this.clock.setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
    });
  }

  private cancelSleep(): void {
    if (this.sleepHandle !== undefined) this.clock.clearTimeout(this.sleepHandle);
    this.sleepHandle = undefined;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private abortCurrent(): void {
    const controller = this.current;
    this.current = undefined;
    controller?.abort();
  }

  private setState(state: ReceiverState): void {
    this.currentState = state;
    try {
      this.o.onState?.(state);
    } catch {
      /* a listener never breaks the receiver */
    }
  }

  // -- one connection -----------------------------------------------------------------------------------------------

  private async connectOnce(gen: number): Promise<ConnectResult> {
    const controller = new AbortController();
    this.current = controller;
    let events = 0;
    let watchdog: unknown;
    let timedOut = false;
    const aborted = new Promise<'aborted'>((resolve) => controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
    const arm = (): void => {
      if (watchdog !== undefined) this.clock.clearTimeout(watchdog);
      watchdog = this.clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.silenceMs);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Seed once per epoch (OkLine `_ensure_local_rev`), then announce the epoch to the buffer.
      if (this.seedPending) {
        // A refresh that ends during the seed must not restart the stream: the seed call keeps its one refresh (A28).
        this.seeding = true;
        let seeded: unknown;
        try {
          seeded = await this.o.gateway.call<unknown>('Talk.TalkService.getLastOpRevision', [], { mode: 'read', signal: controller.signal });
        } finally {
          this.seeding = false;
        }
        const next = toRevision(seeded);
        if (next === null) throw new ChromeError('getLastOpRevision returned no usable revision');
        if (gen !== this.gen) return { events, error: null, fatal: false };
        this.rev = next.toString();
        this.seeded = this.rev;
        this.seedPending = false;
      }
      if (this.epochPending) {
        if (gen !== this.gen) return { events, error: null, fatal: false };
        this.epochPending = false;
        this.o.sink.onEpoch(this.rev);
      }
      const response = await this.openStream(controller);
      if (gen !== this.gen) {
        void response.body?.cancel().catch(() => undefined);
        return { events, error: null, fatal: false };
      }
      if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        // Every non-200 answer is an ordinary failed attempt (OkLine operations.py:423-425). A stale token is renewed by
        // the refresh timer, which reconnects the stream. A dead session stops through the refresh failure path.
        return { events, error: new ChromeSseOpenError(response.status), fatal: false };
      }
      this.setState({ kind: 'open' });
      arm();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      read: while (gen === this.gen) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk === 'aborted' || chunk.done) break;
        // Every completed line re-arms the watchdog, also a comment or a blank line (OkLine operations.py:20-37).
        for (const frame of parser.feed(decoder.decode(chunk.value, { stream: true }), arm)) {
          if (gen !== this.gen) break read;
          if (this.handleFrame(frame)) events += 1;
        }
      }
      return { events, error: timedOut ? new ChromeError('SSE silent for the watchdog window') : null, fatal: false };
    } catch (error) {
      if (error instanceof ChromeLoginRequiredError) return { events, error, fatal: true };
      if (controller.signal.aborted && !timedOut) return { events, error: null, fatal: false };
      return { events, error, fatal: false };
    } finally {
      if (watchdog !== undefined) this.clock.clearTimeout(watchdog);
      if (reader) void reader.cancel().catch(() => undefined);
      if (this.current === controller) this.current = undefined;
      controller.abort();
    }
  }

  /** OkLine `_open_sse` query order, then the gateway's signed GET. */
  private openStream(controller: AbortController): Promise<Response> {
    const params: Array<[string, string]> = [
      ['version', CHROME_EXTENSION_VERSION],
      ['language', this.language],
      ['lastPartialFullSyncs', '{}'], // reset to {} after every open (operations.py:386)
      ['localRev', this.rev],
    ];
    if (this.firstConnect && this.o.fullSyncRequestReason) params.push(['fullSyncRequestReason', this.o.fullSyncRequestReason]);
    this.firstConnect = false; // dropped after the connect attempt, like the extension
    const legy = this.o.legyHost?.trim();
    if (legy) params.push(['legyHost', legy]);
    const query: QueryParams = params;
    const path = specialPath('operation.receive');
    const common = { headerProfile: 'eventsource' as const, signal: controller.signal, timeoutMs: SSE_OPEN_TIMEOUT_MS };
    if (this.authMode === 'cookie') {
      const token = this.o.getAccessToken?.() ?? '';
      if (token === '') return Promise.reject(new ChromeLoginRequiredError('no access token for cookie SSE auth', path));
      return this.o.gateway.get(path, query, { ...common, requireAuth: false, sign: false, extraHeaders: { Cookie: `lct=${token}` } });
    }
    return this.o.gateway.get(path, query, common);
  }

  // -- frames -------------------------------------------------------------------------------------------------------

  /**
   * Handles one dispatched frame (a frame with data). Returns true when the frame counts as an event. A reconnect frame keeps
   * the stream open. A talkException frame is for diagnostics only: it does not close the stream and does not count. The 1/7/8
   * kickout comes from the gateway RPC path only.
   */
  private handleFrame(frame: SseFrame): boolean {
    const name = frame.event;
    const payload = parsePayload(frame.data);
    if (name === 'talkException') {
      const info = extractErrorInfo(payload);
      this.o.onTalkException?.({ code: info.code, reason: info.reason, data: payload });
      this.deliver(extractOperations(payload));
      return false;
    }
    if (SYNC_EVENTS.has(name)) {
      const next = isObject(payload) ? toRevision(payload.nextRevision) : null;
      if (next !== null && next > BigInt(this.rev)) {
        this.rev = next.toString();
        this.o.sink.onFullSync(this.rev);
      }
      return true;
    }
    if (SKIP_EVENTS.has(name)) return true;
    this.deliver(extractOperations(payload));
    return true;
  }

  /** OkLine `iter_operations`/`_seen`: drop ops at or below localRev, advance localRev with the rest. */
  private deliver(operations: ChromeOperation[]): void {
    const fresh: ChromeOperation[] = [];
    let high = BigInt(this.rev);
    for (const op of operations) {
      const rev = opRevision(op);
      if (rev === null) continue; // cannot be ordered or acked by a revision cursor
      if (rev <= BigInt(this.rev)) continue; // stale: delivered before the cursor
      if (rev > high) high = rev;
      fresh.push(op);
    }
    if (fresh.length === 0) return;
    this.rev = high.toString();
    this.o.sink.onOperations(fresh);
  }
}

function normaliseRevision(value: string): string {
  const rev = toRevision(value);
  if (rev === null) throw new RangeError(`invalid localRev ${JSON.stringify(value)}`);
  return rev.toString();
}

function describe(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parsePayload(data: string): unknown {
  const text = data.trim();
  if (text === '') return undefined;
  try {
    return parsePreciseJson(text);
  } catch {
    return undefined;
  }
}

/** OkLine `iter_operations`: a list, `{operations: [...]}`, or a single op with a `type`. */
export function extractOperations(payload: unknown): ChromeOperation[] {
  const list = isObject(payload) && Array.isArray(payload.operations) ? payload.operations : payload;
  if (Array.isArray(list)) return list.filter(isObject) as ChromeOperation[];
  if (isObject(payload) && payload.type !== undefined && payload.type !== null) return [payload as ChromeOperation];
  return [];
}
